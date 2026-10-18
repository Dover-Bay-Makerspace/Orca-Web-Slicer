#!/usr/bin/env python3
"""
Build the browser profile library from an OrcaSlicer source checkout.

OrcaSlicer ships its printer, process (print settings) and filament presets as
JSON files under resources/profiles/<Vendor>/. Each preset is a *sparse* file:
it only lists the settings it changes and names its parent in "inherits".

This script:
  * copies every preset (minified) to  profiles/<vendor-slug>/<type>/<file>.json
  * resolves the inheritance chains (at build time only) to work out which
    process and filament presets are compatible with each printer, the same way
    the desktop app does (compatible_printers list or
    compatible_printers_condition expression)
  * writes profiles/index.json            - vendors and their printers
           profiles/<vendor-slug>/index.json - every preset name -> file/parent,
                                              plus per-printer compatible lists

The web app resolves a preset by walking its "inherits" chain and merging the
files root -> leaf, exactly as OrcaSlicer does, then hands the merged settings
to the slicing engine.

Usage:
  python3 tools/build-profiles.py --orca /path/to/OrcaSlicer --out profiles
  python3 tools/build-profiles.py --orca ... --out profiles --vendors Prusa,Creality,BBL
"""

import argparse
import json
import os
import re
import shutil
import sys

LIBRARY_VENDOR = "OrcaFilamentLibrary"
TYPES = {"machine_list": "machine", "process_list": "process", "filament_list": "filament"}


# ---------------------------------------------------------------- helpers ----

def slug(text):
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("_")
    return s or "x"


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def first_value(value):
    if isinstance(value, list):
        return value[0] if value else ""
    return value


# ------------------------------------------- compatible_printers_condition ----
# OrcaSlicer evaluates these with its PlaceholderParser. The shipped profiles
# only use a small subset: identifiers (optionally indexed), =~ /regex/,
# comparisons, and/or/not and parentheses. Anything else is reported and
# treated as "not compatible" so a bad expression never offers a wrong preset.

TOKEN_RE = re.compile(r"""
    \s*(?:
      (?P<regex>/(?:\\/|[^/])*/)          |
      (?P<str>"(?:\\"|[^"])*")             |
      (?P<num>-?\d+(?:\.\d+)?)             |
      (?P<op>=~|!~|==|!=|<=|>=|<|>|\(|\)|\[|\]|!) |
      (?P<word>[A-Za-z_][A-Za-z0-9_]*)
    )""", re.X)


class ConditionError(Exception):
    pass


def tokenize(expr):
    pos, out = 0, []
    expr = expr.strip()
    while pos < len(expr):
        m = TOKEN_RE.match(expr, pos)
        if not m or m.end() == pos:
            raise ConditionError(f"cannot parse near: {expr[pos:pos+20]!r}")
        pos = m.end()
        kind = m.lastgroup
        out.append((kind, m.group(kind)))
    return out


class Cond:
    def __init__(self, expr, config):
        self.toks = tokenize(expr)
        self.i = 0
        self.cfg = config

    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else (None, None)

    def take(self):
        t = self.peek()
        self.i += 1
        return t

    def run(self):
        v = self.or_()
        if self.i != len(self.toks):
            raise ConditionError("trailing tokens")
        return bool(v)

    def or_(self):
        v = self.and_()
        while self.peek() in (("word", "or"),):
            self.take()
            r = self.and_()
            v = bool(v) or bool(r)
        return v

    def and_(self):
        v = self.not_()
        while self.peek() in (("word", "and"),):
            self.take()
            r = self.not_()
            v = bool(v) and bool(r)
        return v

    def not_(self):
        if self.peek() in (("word", "not"), ("op", "!")):
            self.take()
            return not self.not_()
        return self.cmp()

    def cmp(self):
        left = self.atom()
        kind, val = self.peek()
        if kind == "op" and val in ("=~", "!~"):
            self.take()
            k2, rx = self.take()
            if k2 != "regex":
                raise ConditionError("regex expected")
            hit = re.search(rx[1:-1].replace("\\/", "/"), str(left)) is not None
            return hit if val == "=~" else not hit
        if kind == "op" and val in ("==", "!=", "<", ">", "<=", ">="):
            self.take()
            right = self.atom()
            a, b = coerce(left, right)
            return {"==": a == b, "!=": a != b, "<": a < b, ">": a > b,
                    "<=": a <= b, ">=": a >= b}[val]
        return left

    def atom(self):
        kind, val = self.take()
        if kind == "op" and val == "(":
            v = self.or_()
            if self.take() != ("op", ")"):
                raise ConditionError(") expected")
            return v
        if kind == "num":
            return float(val)
        if kind == "str":
            return val[1:-1]
        if kind == "word":
            if val in ("true", "false"):
                return val == "true"
            value = self.cfg.get(val, "")
            if self.peek() == ("op", "["):
                self.take()
                k, idx = self.take()
                if self.take() != ("op", "]") or k != "num":
                    raise ConditionError("bad index")
                idx = int(float(idx))
                if isinstance(value, list):
                    value = value[idx] if idx < len(value) else ""
                elif isinstance(value, str) and "," in value:
                    parts = value.split(",")
                    value = parts[idx] if idx < len(parts) else ""
            else:
                value = first_value(value) if isinstance(value, list) and len(value) == 1 else value
                if isinstance(value, list):
                    value = ";".join(map(str, value))
            return value
        raise ConditionError(f"unexpected token {val!r}")


def coerce(a, b):
    try:
        return float(a), float(b)
    except (TypeError, ValueError):
        return str(a), str(b)


def condition_ok(expr, machine_cfg, problems, label):
    try:
        return Cond(expr, machine_cfg).run()
    except ConditionError as exc:
        problems.append(f"{label}: {exc} in {expr!r}")
        return False


# -------------------------------------------------------------- the build ----

class Library:
    def __init__(self, root):
        self.root = root
        # (vendor, type, name) -> record
        self.presets = {}
        self.vendors = []

    def load_vendor(self, vendor):
        index = load_json(os.path.join(self.root, vendor + ".json"))
        for list_key, ptype in TYPES.items():
            for entry in index.get(list_key, []):
                path = os.path.join(self.root, vendor, entry["sub_path"])
                if not os.path.isfile(path):
                    continue
                try:
                    data = load_json(path)
                except (ValueError, OSError) as exc:
                    print(f"  ! skipping unreadable {path}: {exc}", file=sys.stderr)
                    continue
                name = data.get("name") or entry["name"]
                self.presets[(vendor, ptype, name)] = {
                    "vendor": vendor, "type": ptype, "name": name,
                    "sub_path": entry["sub_path"], "data": data,
                }
        self.vendors.append(vendor)

    def find(self, vendor, ptype, name):
        for v in (vendor, LIBRARY_VENDOR):
            rec = self.presets.get((v, ptype, name))
            if rec:
                return rec
        for (v, t, n), rec in self.presets.items():
            if t == ptype and n == name:
                return rec
        return None

    def resolve(self, rec, _seen=None):
        """Merged settings for a preset (root first, leaf wins)."""
        if "resolved" in rec:
            return rec["resolved"]
        seen = _seen or set()
        key = (rec["vendor"], rec["type"], rec["name"])
        if key in seen:
            raise RuntimeError(f"inheritance loop at {key}")
        seen.add(key)
        merged = {}
        parent_name = rec["data"].get("inherits")
        if parent_name:
            parent = self.find(rec["vendor"], rec["type"], parent_name)
            if parent:
                merged.update(self.resolve(parent, seen))
                rec["parent"] = parent
            else:
                rec["missing_parent"] = parent_name
        merged.update(rec["data"])
        rec["resolved"] = merged
        return merged


def is_instance(cfg):
    return str(cfg.get("instantiation", "")).lower() == "true"


def compatible(preset_cfg, machine_name, machine_cfg, problems, label):
    printers = preset_cfg.get("compatible_printers") or []
    if isinstance(printers, str):
        printers = [p for p in printers.split(";") if p]
    if printers:
        return machine_name in printers
    cond = preset_cfg.get("compatible_printers_condition", "")
    if cond:
        return condition_ok(cond, machine_cfg, problems, label)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--orca", required=True, help="OrcaSlicer source checkout (needs resources/profiles)")
    ap.add_argument("--out", default="profiles", help="output directory (replaced)")
    ap.add_argument("--vendors", default="", help="comma-separated vendor folder names to include (default: all)")
    args = ap.parse_args()

    root = os.path.join(args.orca, "resources", "profiles")
    if not os.path.isdir(root):
        sys.exit(f"no resources/profiles under {args.orca}")

    all_vendors = sorted(f[:-5] for f in os.listdir(root)
                         if f.endswith(".json") and os.path.isdir(os.path.join(root, f[:-5])))
    # Brand names are matched forgivingly: any capitals, spaces or dashes, and a
    # few everyday names for folders OrcaSlicer names differently. Unknown names
    # are skipped with a warning instead of failing the whole build.
    def norm(text):
        return re.sub(r"[^a-z0-9]", "", text.lower())
    aliases = {"bambu": "BBL", "bambulab": "BBL", "bambulabs": "BBL", "prusaresearch": "Prusa",
               "ratrig": "Ratrig", "lulzbot": "Lulzbot", "ultimaker": "UltiMaker", "qidi": "Qidi",
               "qiditech": "Qidi", "flashforge": "Flashforge", "bigtreetech": "BIQU", "btt": "BIQU"}
    by_norm = {norm(v): v for v in all_vendors}
    requested = [v.strip() for v in re.split(r"[,;\n]", args.vendors) if v.strip()]
    wanted, unknown = [], []
    for name in requested:
        key = norm(name)
        match = by_norm.get(key) or (aliases.get(key) if aliases.get(key) in all_vendors else None)
        if not match:
            starts = [v for k, v in by_norm.items() if k.startswith(key)] if len(key) >= 3 else []
            match = starts[0] if len(starts) == 1 else None
        if match:
            if match not in wanted:
                wanted.append(match)
        else:
            unknown.append(name)
    if unknown:
        print(f"WARNING: skipping unknown printer brand(s): {', '.join(unknown)}", file=sys.stderr)
        print(f"         available: {', '.join(all_vendors)}", file=sys.stderr)
    if requested and not [v for v in wanted if v != LIBRARY_VENDOR]:
        print("WARNING: none of the requested brands matched, so all brands are included.", file=sys.stderr)
        wanted = []
    if not wanted:
        wanted = list(all_vendors)
    if LIBRARY_VENDOR in all_vendors and LIBRARY_VENDOR not in wanted:
        wanted.append(LIBRARY_VENDOR)

    lib = Library(root)
    # Load every vendor so cross-vendor "inherits" resolve, but only publish the wanted ones.
    for v in all_vendors:
        lib.load_vendor(v)

    version = ""
    try:
        version = load_json(os.path.join(root, LIBRARY_VENDOR + ".json")).get("version", "")
    except OSError:
        pass

    if os.path.isdir(args.out):
        shutil.rmtree(args.out)
    os.makedirs(args.out)

    problems = []
    published = {}   # (vendor,type,name) -> relative file path

    def publish(rec):
        key = (rec["vendor"], rec["type"], rec["name"])
        if key in published:
            return published[key]
        rel = "/".join([slug(rec["vendor"]), rec["type"], slug(rec["name"]) + ".json"])
        published[key] = rel
        lib.resolve(rec)  # links rec["parent"]
        data = dict(rec["data"])
        if rec.get("parent"):
            # Record the parent's file so the browser can walk the chain without
            # name lookups (base names like fdm_machine_common repeat per vendor).
            data["_parent"] = publish(rec["parent"])
        dest = os.path.join(args.out, rel)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "w", encoding="utf-8") as fh:
            json.dump(data, fh, separators=(",", ":"), ensure_ascii=False)
        return rel

    # Generic filaments from the shared library that fit any printer.
    library_filaments = []
    for (v, t, n), rec in lib.presets.items():
        if v != LIBRARY_VENDOR or t != "filament":
            continue
        cfg = lib.resolve(rec)
        if is_instance(cfg) and not cfg.get("compatible_printers") and not cfg.get("compatible_printers_condition"):
            library_filaments.append(rec)
    library_filaments.sort(key=lambda r: (first_value(lib.resolve(r).get("filament_vendor", "")) != "Generic",
                                          str(first_value(lib.resolve(r).get("filament_vendor", ""))), r["name"]))

    def entry(rec):
        cfg = lib.resolve(rec)
        e = {"name": rec["name"], "file": publish(rec)}
        if rec["type"] == "filament":
            e["type"] = first_value(cfg.get("filament_type", ""))
            e["brand"] = first_value(cfg.get("filament_vendor", "")) or rec["vendor"]
        if rec["type"] == "process":
            e["layer"] = first_value(cfg.get("layer_height", ""))
        return e

    lib_index = {"filaments": [entry(r) for r in library_filaments]}
    with open(os.path.join(args.out, "library.json"), "w", encoding="utf-8") as fh:
        json.dump(lib_index, fh, separators=(",", ":"), ensure_ascii=False)

    top = {"orcaProfileVersion": version, "vendors": []}
    totals = {"printers": 0, "processes": 0, "filaments": 0}

    for vendor in wanted:
        if vendor == LIBRARY_VENDOR:
            continue
        recs = [r for (v, t, n), r in lib.presets.items() if v == vendor]
        machines = sorted((r for r in recs if r["type"] == "machine" and is_instance(lib.resolve(r))),
                          key=lambda r: r["name"])
        if not machines:
            continue
        processes = [r for r in recs if r["type"] == "process" and is_instance(lib.resolve(r))]
        filaments = [r for r in recs if r["type"] == "filament" and is_instance(lib.resolve(r))]
        process_entries = {r["name"]: entry(r) for r in processes}
        filament_entries = {r["name"]: entry(r) for r in filaments}

        printers = []
        for m in machines:
            mcfg = lib.resolve(m)
            if str(first_value(mcfg.get("printer_technology", "FFF"))) not in ("FFF", ""):
                continue
            comp_p = [r["name"] for r in processes
                      if compatible(lib.resolve(r), m["name"], mcfg, problems, f"{vendor}/{r['name']}")]
            comp_f = [r["name"] for r in filaments
                      if compatible(lib.resolve(r), m["name"], mcfg, problems, f"{vendor}/{r['name']}")]
            dprint = first_value(mcfg.get("default_print_profile", ""))
            dfil = first_value(mcfg.get("default_filament_profile", ""))
            printers.append({
                "name": m["name"],
                "model": first_value(mcfg.get("printer_model", "")) or m["name"],
                "nozzle": first_value(mcfg.get("nozzle_diameter", "")),
                "file": publish(m),
                "processes": sorted(comp_p, key=lambda n: (process_entries[n].get("layer", ""), n)),
                "filaments": sorted(comp_f),
                "defaultProcess": dprint if dprint in comp_p else (comp_p[0] if comp_p else ""),
                "defaultFilament": dfil,
                "defaultBedType": first_value(mcfg.get("default_bed_type", "")),
            })
        if not printers:
            continue
        used_p = {n for p in printers for n in p["processes"]}
        used_f = {n for p in printers for n in p["filaments"]}
        vindex = {
            "vendor": vendor,
            "printers": printers,
            "processes": [process_entries[n] for n in sorted(used_p)],
            "filaments": [filament_entries[n] for n in sorted(used_f)],
        }
        vfile = slug(vendor) + "/index.json"
        os.makedirs(os.path.join(args.out, slug(vendor)), exist_ok=True)
        with open(os.path.join(args.out, vfile), "w", encoding="utf-8") as fh:
            json.dump(vindex, fh, separators=(",", ":"), ensure_ascii=False)
        top["vendors"].append({
            "name": vendor, "index": vfile,
            "models": sorted({p["model"] for p in printers}),
            "printers": len(printers),
        })
        totals["printers"] += len(printers)
        totals["processes"] += len(used_p)
        totals["filaments"] += len(used_f)

    top["vendors"].sort(key=lambda v: v["name"].lower())
    # A small name -> file map so imported user presets can find their system parents.
    top["library"] = "library.json"
    with open(os.path.join(args.out, "index.json"), "w", encoding="utf-8") as fh:
        json.dump(top, fh, separators=(",", ":"), ensure_ascii=False)

    # name -> file for selectable system presets, used to resolve the parent of
    # a user preset exported from the desktop app ("inherits": "<system name>").
    names = {}
    for (v, t, n), rel in published.items():
        if is_instance(lib.presets[(v, t, n)]["resolved"]):
            names.setdefault(t, {})[n] = rel
    with open(os.path.join(args.out, "names.json"), "w", encoding="utf-8") as fh:
        json.dump(names, fh, separators=(",", ":"), ensure_ascii=False)

    missing = sorted({r.get("missing_parent") for r in lib.presets.values() if r.get("missing_parent")})
    print(f"Orca profile library {version}: {len(top['vendors'])} vendors, {totals['printers']} printers, "
          f"{totals['processes']} process presets, {totals['filaments']} vendor filaments, "
          f"{len(lib_index['filaments'])} library filaments, {len(published)} files")
    if missing:
        print(f"  {len(missing)} parent preset(s) not found (presets still published): "
              + ", ".join(missing[:8]) + (" ..." if len(missing) > 8 else ""))
    if problems:
        print(f"  {len(problems)} compatibility expression(s) could not be evaluated; first: {problems[0]}")


if __name__ == "__main__":
    main()
