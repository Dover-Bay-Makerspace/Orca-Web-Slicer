#!/usr/bin/env python3
"""Add a printer that only a newer OrcaSlicer has to the site, before the
engine is updated to that version.

Builds one custom-printers/ file with the printer's presets (printer, print
settings and filaments) from the newer OrcaSlicer, each flattened (parents and
G-code templates merged in) and trimmed to the settings the site's engine
knows. Each preset also keeps every original setting under "_workstation";
the site writes those back into saved projects, so the workstation's desktop
OrcaSlicer or Bambu Studio gets the printer's own presets and G-code.

usage:
  python3 tools/newer-printer-presets.py NEW_ORCA OLD_ORCA OLD_SCHEMA \
      tools/build-profiles.py OUT_JSON [VENDOR] [NAME_PART]

  NEW_ORCA    OrcaSlicer checkout of the newer version (resources/profiles)
  OLD_ORCA    OrcaSlicer checkout of the engine's version (src/libslic3r and
              resources/profiles/BBL)
  OLD_SCHEMA  settings-schema.json built from OLD_ORCA
  VENDOR      profile folder, default BBL; NAME_PART picks the printers,
              default A2L

Example (Bambu Lab A2L, OrcaSlicer 2.5.0, engine 2.4.2):
  python3 tools/newer-printer-presets.py orca-2.5.0 orca-2.4.2 schema-2.4.2.json \
      tools/build-profiles.py "custom-printers/Bambu Lab A2L (from OrcaSlicer 2.5.0).json"

Delete the file it made once the engine is on the newer version: the printer
then comes with the normal profiles.
"""
import importlib.util, json, re, sys

new_orca, old_orca, old_schema, bp_path, out_path = sys.argv[1:6]
VENDOR = sys.argv[6] if len(sys.argv) > 6 else "BBL"
PART = sys.argv[7] if len(sys.argv) > 7 else "A2L"
spec = importlib.util.spec_from_file_location("bp", bp_path)
bp = importlib.util.module_from_spec(spec)
sys.argv = [bp_path]
spec.loader.exec_module(bp)

root = new_orca + "/resources/profiles"
lib = bp.Library(root)
for v in (VENDOR, "OrcaFilamentLibrary"):
    lib.load_vendor(v)

old_text = open(old_orca + "/src/libslic3r/PrintConfig.cpp", encoding="utf-8").read()
old_keys = set(re.findall(r'this->add(?:_nullable)?\("([a-z0-9_]+)"', old_text))
# Settings the older code makes in loops: per-axis machine limits and the
# per-filament retraction overrides.
for kind in ("speed", "acceleration", "jerk"):
    for axis in "xyze":
        old_keys.add(f"machine_max_{kind}_{axis}")
m = re.search(r"filament_extruder_override_keys\s*=\s*\{(.*?)\};", old_text, re.S)
if m:
    old_keys.update(re.findall(r'"([a-z0-9_]+)"', m.group(1)))
# Every setting the older version's own Bambu presets use is known to it.
import os
for d in (VENDOR, "OrcaFilamentLibrary"):
    for dp, _, fs in os.walk(os.path.join(old_orca, "resources/profiles", d)):
        for f in fs:
            if f.endswith(".json"):
                try:
                    old_keys.update(json.load(open(os.path.join(dp, f), encoding="utf-8")).keys())
                except ValueError:
                    pass
options = json.load(open(old_schema, encoding="utf-8"))["options"]
META = {"name", "type", "from", "instantiation", "setting_id", "filament_id", "compatible_printers",
        "compatible_printers_condition", "compatible_prints", "compatible_prints_condition",
        "printer_model", "printer_variant", "default_print_profile", "default_filament_profile",
        "default_bed_type", "version", "filament_vendor", "description"}

machines = [r for (v, t, n), r in lib.presets.items()
            if v == VENDOR and t == "machine" and PART in n and bp.is_instance(lib.resolve(r))]
mnames = sorted(r["name"] for r in machines)


def fits(cfg):
    printers = cfg.get("compatible_printers") or []
    if isinstance(printers, str):
        printers = [p for p in printers.split(";") if p]
    return any(n in printers for n in mnames)


picked = {"machine": machines, "process": [], "filament": []}
for (v, t, n), r in lib.presets.items():
    if t in ("process", "filament") and bp.is_instance(lib.resolve(r)) and fits(lib.resolve(r)):
        picked[t].append(r)

def full(rec):
    """Settings for a preset with its parents and its "include" templates merged
    in (newer OrcaSlicer keeps long G-code in template presets it includes)."""
    chain = []
    while rec:
        lib.resolve(rec)
        chain.append(rec)
        rec = rec.get("parent")
    merged = {}
    for level in reversed(chain):
        own = {k: v for k, v in level["data"].items() if k != "include"}
        merged.update(own)
        inc = level["data"].get("include") or []
        if isinstance(inc, str):
            inc = [inc]
        for name in inc:
            t = lib.find(level["vendor"], level["type"], name)
            if not t:
                raise SystemExit(f"include not found: {name}")
            merged.update({k: v for k, v in full(t).items()
                           if k not in ("name", "type", "instantiation", "inherits", "from", "setting_id")})
        merged.update(own)
    return merged


GCODE_KEYS = ("machine_start_gcode", "machine_end_gcode", "change_filament_gcode", "layer_change_gcode",
              "before_layer_change_gcode", "time_lapse_gcode", "machine_pause_gcode", "template_custom_gcode")


def web_gcode(text, cfg):
    """G-code with OrcaSlicer 2.5 variables written the 2.4 way, for a printer
    with one nozzle (filament ids are the old extruder numbers and every nozzle
    id is 0). Only the site's own preview slice uses this text."""
    def first(key, default):
        v = cfg.get(key, default)
        return str(v[0] if isinstance(v, list) and v else v)
    rules = [
        (r"nozzle_diameter_at_nozzle_id\[[^\]]*\]", "nozzle_diameter[0]"),
        (r"hotend_cooling_rate\[(?:filament_map\[[a-z_]+\]-1|[0-9]+)\]", first("hotend_cooling_rate", "2")),
        (r"hotend_heating_rate\[(?:filament_map\[[a-z_]+\]-1|[0-9]+)\]", first("hotend_heating_rate", "2")),
        (r"\binitial_no_support_filament_id\b", "initial_no_support_extruder"),
        (r"\binitial_filament_id\b", "initial_extruder"),
        (r"\bcurrent_filament_id\b", "previous_extruder"),
        (r"\bnext_filament_id\b", "next_extruder"),
        (r"\b(?:initial|current|next)_nozzle_id\b", "0"),
        (r"\[curr_y_acceleration_limit\]", first("machine_max_acceleration_y", "8000")),
        (r"\[clear_to_x0\]", "0"),
        (r"\bclear_to_x0\b", "false"),
    ]
    for pat, rep in rules:
        text = re.sub(pat, rep, text)
    return text


# Every setting of the newer preset is kept as it is in "_workstation", so the
# saved project matches the printer's own presets in the desktop app.
SKIP_ORIGINAL = {"inherits", "_parent", "include", "name", "type", "from", "instantiation", "setting_id",
                 "compatible_printers", "compatible_printers_condition", "compatible_prints",
                 "compatible_prints_condition", "version", "description", "renamed_from"}

dropped, fixed = {}, {}
out = []
for t in ("machine", "process", "filament"):
    for r in sorted(picked[t], key=lambda r: r["name"]):
        cfg = full(r)
        clean = {}
        for k, val in cfg.items():
            if k in ("inherits", "_parent"):
                continue
            if k not in META and k not in old_keys:
                dropped[k] = dropped.get(k, 0) + 1
                continue
            o = options.get(k)
            if o and o.get("type") in ("Enum", "Enums") and o.get("choices"):
                allowed = {c[0] for c in o["choices"]}
                vals = val if isinstance(val, list) else [val]
                if any(str(x) not in allowed for x in vals):
                    fixed[f"{k}={val}"] = fixed.get(f"{k}={val}", 0) + 1
                    continue
            if o and o.get("type") in ("Bool", "Bools"):
                vals = val if isinstance(val, list) else [val]
                if any(str(x) not in ("0", "1", "true", "false", "nil") for x in vals):
                    fixed[f"{k}={val}"] = fixed.get(f"{k}={val}", 0) + 1
                    continue
            clean[k] = val
        if t == "machine":
            originals = {}
            for gk in GCODE_KEYS:
                if gk in clean:
                    web = web_gcode(clean[gk], cfg)
                    if web != clean[gk]:
                        originals[gk] = clean[gk]
                        clean[gk] = web
            # The newer settings the older engine can't take, and the G-code it
            # can't run, kept so the saved project carries the printer's own.
            clean["_workstation"] = {k: v for k, v in cfg.items() if k not in SKIP_ORIGINAL}
        else:
            clean["_workstation"] = {k: v for k, v in cfg.items() if k not in SKIP_ORIGINAL}
        if t != "machine":
            clean["compatible_printers"] = [n for n in mnames if n in (cfg.get("compatible_printers") or [])]
            clean.pop("compatible_printers_condition", None)
        clean["name"] = r["name"]
        clean["type"] = t
        clean["from"] = "system"
        clean["instantiation"] = "true"
        clean["_brand"] = VENDOR  # listed with the rest of the brand on the site
        out.append(clean)

with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(out, fh, indent=1, ensure_ascii=False)
print("printers:", mnames)
print("process presets:", len(picked["process"]), " filaments:", len(picked["filament"]))
print("settings left out (not in the older engine):", ", ".join(sorted(dropped)))
print("values left out (not valid in the older engine):", ", ".join(sorted(fixed)))
