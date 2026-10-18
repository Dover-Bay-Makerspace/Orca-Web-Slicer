#!/usr/bin/env python3
"""
Build settings-schema.json for the Advanced settings editor from an OrcaSlicer
source checkout.

It reads two OrcaSlicer source files:
  src/slic3r/GUI/Tab.cpp            which settings appear on which tab/page/group
                                    of the desktop app, in what order
  src/libslic3r/PrintConfig.cpp     each setting's label, tooltip, type, unit,
                                    limits, choices and simple/advanced level

so the web editor shows the same settings, in the same places, with the same
names and help text as desktop OrcaSlicer.

Usage:
  python3 tools/build-settings-schema.py --orca /path/to/OrcaSlicer --out settings-schema.json

The checkout needs those two files (a sparse checkout is fine).
"""

import argparse
import json
import os
import re
import sys

# Pages that only make sense in the desktop app.
SKIP_PAGES = {"Dependencies", "Notes"}
# Settings drawn with custom desktop widgets, or tied to printer connections.
SKIP_KEYS = {
    "printable_area", "compatible_printers", "compatible_prints", "filament_ramming_parameters",
    "bbl_use_printhost", "use_3mf", "scan_first_layer", "inherits",
}

STR_RE = re.compile(r'(?:u8)?"((?:[^"\\]|\\.)*)"')


def unescape(s):
    out, i = [], 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            n = s[i + 1]
            if n == "n":
                out.append("\n"); i += 2; continue
            if n == "t":
                out.append("\t"); i += 2; continue
            if n == "u" and i + 5 < len(s):
                try:
                    out.append(chr(int(s[i + 2:i + 6], 16))); i += 6; continue
                except ValueError:
                    pass
            out.append(n); i += 2; continue
        out.append(c); i += 1
    return "".join(out)


def strip_comments(code):
    """Remove // and /* */ comments but keep string literals intact."""
    out, i, n = [], 0, len(code)
    while i < n:
        c = code[i]
        if c == '"':
            j = i + 1
            while j < n and code[j] != '"':
                j += 2 if code[j] == "\\" else 1
            out.append(code[i:j + 1]); i = j + 1
        elif code.startswith("//", i):
            j = code.find("\n", i)
            i = n if j < 0 else j
        elif code.startswith("/*", i):
            j = code.find("*/", i + 2)
            i = n if j < 0 else j + 2
        else:
            out.append(c); i += 1
    return "".join(out)


def drop_if0(code):
    """Remove #if 0 ... #endif blocks (with nesting)."""
    lines, out, depth = code.split("\n"), [], 0
    for line in lines:
        s = line.strip()
        if depth:
            if s.startswith("#if"):
                depth += 1
            elif s.startswith("#endif"):
                depth -= 1
            elif s.startswith("#else") and depth == 1:
                depth = 0
            continue
        if s.startswith("#if 0"):
            depth = 1
            continue
        out.append(line)
    return "\n".join(out)


def literal_after(text, start):
    """Concatenated string literals of the L(...) / "..." expression starting at text[start:]."""
    m = re.match(r'\s*(?:_?L\s*\(|_u8L\s*\()?', text[start:])
    pos = start + (m.end() if m else 0)
    parts = []
    while True:
        m = re.match(r'\s*(?:u8)?"((?:[^"\\]|\\.)*)"', text[pos:])
        if not m:
            break
        parts.append(unescape(m.group(1)))
        pos += m.end()
    return "".join(parts) if parts else None


def function_body(code, signature):
    i = code.find(signature)
    if i < 0:
        return ""
    j = code.find("{", i)
    depth, k = 0, j
    while k < len(code):
        if code[k] == "{":
            depth += 1
        elif code[k] == "}":
            depth -= 1
            if depth == 0:
                return code[j:k + 1]
        elif code[k] == '"':
            k += 1
            while k < len(code) and code[k] != '"':
                k += 2 if code[k] == "\\" else 1
        k += 1
    return code[j:]


# ------------------------------------------------------------------ Tab.cpp --

TOKEN = re.compile(
    r'add_options_page\(\s*(?P<page>L\("(?:[^"\\]|\\.)*"\)|page_name)'
    r'|new_optgroup\(\s*(?P<group>L?\("(?:[^"\\]|\\.)*"\)|"(?:[^"\\]|\\.)*")'
    r'|(?:Line\s+\w+|\b\w*line)\s*=\s*(?:Line)?\s*\{\s*(?P<line>L\("(?:[^"\\]|\\.)*"\)|_?L?\(?"(?:[^"\\]|\\.)*")'
    r'|append_single_option_line\(\s*"(?P<single>[a-z0-9_]+)"'
    r'|get_option\(\s*"(?P<getopt>[a-z0-9_]+)"'
    r'|create_line_with_widget\([^,]+,\s*"(?P<widget>[a-z0-9_]+)"'
    r'|append_option_line\(\s*optgroup\s*,\s*(?P<aol>"[a-z0-9_]+"(?:\s*\+\s*\w+)?|\w+)'
    r'|for\s*\(\s*const\s+std::string\s*&\s*(?P<forvar>\w+)\s*:\s*(?P<forlist>\w+)\s*\)'
    r'|std::vector<std::string>\s+(?P<vecname>\w+)\s*\{(?P<vecitems>[^}]*)\}'
    r'|append_line\(\s*(?P<appendline>\w+)\s*\)'
)


def parse_tab(body, page_override=None):
    pages, page, group = [], None, None
    vectors, loopvars = {}, {}
    line_label = None
    seen = set()

    def ensure_group():
        nonlocal page, group
        if page is None:
            page = {"name": page_override or "General", "groups": []}
            pages.append(page)
        if group is None:
            group = {"name": "", "options": []}
            page["groups"].append(group)

    def add(key, label_prefix=None):
        if key in SKIP_KEYS or (page and page["name"] in SKIP_PAGES):
            return
        ensure_group()
        ident = (page["name"], key)
        if ident in seen:
            return
        seen.add(ident)
        entry = {"key": key}
        if label_prefix:
            entry["line"] = label_prefix
        group["options"].append(entry)

    for m in TOKEN.finditer(body):
        g = m.lastgroup
        if m.group("page"):
            raw = m.group("page")
            name = literal_after(raw, 0) if raw != "page_name" else "Extruder"
            page = {"name": page_override or name, "groups": []}
            pages.append(page)
            group, line_label = None, None
        elif m.group("group") is not None:
            name = literal_after(m.group("group"), 0) or ""
            if page is None:
                ensure_group()
            group = {"name": name, "options": []}
            page["groups"].append(group)
            line_label = None
        elif m.group("line") is not None:
            line_label = literal_after(m.group("line"), 0)
        elif m.group("single"):
            line_label = None
            add(m.group("single"))
        elif m.group("getopt"):
            add(m.group("getopt"), line_label)
        elif m.group("widget"):
            add(m.group("widget"))
        elif m.group("aol"):
            expr = m.group("aol").strip()
            mm = re.match(r'"([a-z0-9_]+)"\s*\+\s*(\w+)', expr)
            if mm:
                for v in vectors.get(loopvars.get(mm.group(2), ""), []):
                    add(mm.group(1) + v)
            elif expr.startswith('"'):
                add(expr.strip('"'))
            else:
                for v in vectors.get(loopvars.get(expr, ""), []):
                    add(v)
        elif m.group("forvar"):
            loopvars[m.group("forvar")] = m.group("forlist")
        elif m.group("vecname"):
            vectors[m.group("vecname")] = [unescape(s) for s in STR_RE.findall(m.group("vecitems"))]
        elif m.group("appendline"):
            line_label = None

    # Drop skipped pages and empty groups/pages.
    out = []
    for p in pages:
        if p["name"] in SKIP_PAGES:
            continue
        groups = [g for g in p["groups"] if g["options"]]
        if not groups:
            continue
        # Merge pages with the same name (e.g. the extruder page appears once per extruder).
        existing = next((q for q in out if q["name"] == p["name"]), None)
        if existing:
            existing["groups"].extend(groups)
        else:
            out.append({"name": p["name"], "groups": groups})
    return out


# ---------------------------------------------------------- PrintConfig.cpp --

def parse_defs(code):
    defs = {}
    starts = [m for m in re.finditer(r'(?:auto\s+(\w+)\s*=\s*)?def\s*=\s*this->add(?:_nullable)?\(\s*"([a-z0-9_]+)"\s*,\s*(co\w+)\s*\)', code)]
    aliases = {}
    for idx, m in enumerate(starts):
        end = starts[idx + 1].start() if idx + 1 < len(starts) else len(code)
        block = code[m.end():end]
        key, ctype = m.group(2), m.group(3)
        if m.group(1):
            aliases[m.group(1)] = key
        d = {"type": ctype[2:]}

        def field(name):
            mm = re.search(r'def->' + name + r'\s*=\s*', block)
            return literal_after(block, mm.end()) if mm else None

        for name, out in (("label", "label"), ("full_label", "fullLabel"), ("tooltip", "tooltip"),
                          ("sidetext", "unit"), ("category", "category")):
            v = field(name)
            if v:
                d[out] = v.strip()
        for name in ("min", "max"):
            mm = re.search(r'def->' + name + r'\s*=\s*(-?[\d.]+)\s*;', block)
            if mm:
                d[name] = float(mm.group(1))
        mm = re.search(r'def->mode\s*=\s*com(\w+)', block)
        d["mode"] = (mm.group(1).lower() if mm else "advanced")
        if re.search(r'def->multiline\s*=\s*true', block) or re.search(r'def->is_code\s*=\s*true', block):
            d["multiline"] = True
        if re.search(r'def->readonly\s*=\s*true', block):
            d["readonly"] = True
        mm = re.search(r'def->ratio_over\s*=\s*"([a-z0-9_]+)"', block)
        if mm:
            d["ratioOver"] = mm.group(1)
        mm = re.search(r'def->gui_type\s*=\s*ConfigOptionDef::GUIType::(\w+)', block)
        if mm:
            d["gui"] = mm.group(1)
        values = [unescape(v) for v in re.findall(r'def->enum_values\.(?:push_back|emplace_back)\(\s*"((?:[^"\\]|\\.)*)"\s*\)', block)]
        labels = []
        for lm in re.finditer(r'def->enum_labels\.(?:push_back|emplace_back)\(', block):
            labels.append(literal_after(block, lm.end()) or "")
        if not values:
            mm = re.search(r'def->enum_values\s*=\s*\{([^}]*)\}', block)
            if mm:
                values = [unescape(v) for v in STR_RE.findall(mm.group(1))]
                ml = re.search(r'def->enum_labels\s*=\s*\{([^}]*)\}', block)
                labels = [unescape(v) for v in STR_RE.findall(ml.group(1))] if ml else []
        mm = re.search(r'def->enum_values\s*=\s*(\w+)->enum_values', block)
        if not values and mm:
            d["choicesFrom"] = mm.group(1)
        if values:
            d["choices"] = [[v, labels[i] if i < len(labels) and labels[i] else v] for i, v in enumerate(values)]
        mm = re.search(r'set_default_value\(\s*new\s+ConfigOption(\w+)\s*(?:<[^>]*>)?\s*[({]\s*(.*?)\s*[)}]\s*\)\s*;', block, re.S)
        if mm:
            raw = mm.group(2)
            lits = STR_RE.findall(raw)
            if lits:
                d["default"] = unescape(lits[0])
            elif re.fullmatch(r'-?[\d.]+', raw.strip()):
                d["default"] = raw.strip()
            elif re.fullmatch(r'(-?[\d.]+)\s*,\s*(true|false)', raw.strip()):
                num, pct = re.fullmatch(r'(-?[\d.]+)\s*,\s*(true|false)', raw.strip()).groups()
                d["default"] = num.rstrip('.') + ('%' if pct == 'true' else '')
            elif raw.strip() in ("true", "false"):
                d["default"] = "1" if raw.strip() == "true" else "0"
        defs[key] = d

    for d in defs.values():
        src = aliases.get(d.pop("choicesFrom", None) or "")
        if src and defs.get(src, {}).get("choices"):
            d["choices"] = defs[src]["choices"]

    # Machine limits are defined in a loop over the X/Y/Z/E axes.
    for axis in "xyze":
        A = axis.upper()
        for prefix, name, unit in (("machine_max_speed_", "Maximum speed", "mm/s"),
                                   ("machine_max_acceleration_", "Maximum acceleration", "mm/s\u00b2"),
                                   ("machine_max_jerk_", "Maximum jerk", "mm/s")):
            defs.setdefault(prefix + axis, {
                "type": "Floats", "label": f"{name} {A}", "tooltip": f"{name} of the {A} axis",
                "unit": unescape(unit), "min": 0.0, "mode": "simple", "category": "Machine limits",
            })
    return defs


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--orca", required=True)
    ap.add_argument("--out", default="settings-schema.json")
    a = ap.parse_args()

    tab_path = os.path.join(a.orca, "src", "slic3r", "GUI", "Tab.cpp")
    cfg_path = os.path.join(a.orca, "src", "libslic3r", "PrintConfig.cpp")
    for p in (tab_path, cfg_path):
        if not os.path.isfile(p):
            sys.exit(f"missing {p}")

    tab = drop_if0(strip_comments(open(tab_path, encoding="utf-8").read()))
    cfg = drop_if0(strip_comments(open(cfg_path, encoding="utf-8").read()))
    defs = parse_defs(cfg)

    tabs = {
        "process": parse_tab(function_body(tab, "void TabPrint::build()")),
        "filament": parse_tab(function_body(tab, "void TabFilament::build()")),
        "machine": parse_tab(function_body(tab, "void TabPrinter::build_fff()"))
                   + parse_tab(function_body(tab, "PageShp TabPrinter::build_kinematics_page()"))
                   + parse_tab(function_body(tab, "void TabPrinter::build_unregular_pages(")),
    }

    used, missing = set(), []
    for t, pages in tabs.items():
        for p in pages:
            for g in p["groups"]:
                kept = []
                for o in g["options"]:
                    if o["key"] in defs:
                        kept.append(o)
                        used.add(o["key"])
                    else:
                        missing.append(o["key"])
                g["options"] = kept
            p["groups"] = [g for g in p["groups"] if g["options"]]
        tabs[t] = [p for p in pages if p["groups"]]

    schema = {"tabs": tabs, "options": {k: defs[k] for k in sorted(used)}}
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(schema, fh, separators=(",", ":"), ensure_ascii=False)
    counts = {t: sum(len(g["options"]) for p in v for g in p["groups"]) for t, v in tabs.items()}
    print(f"settings schema: {counts} settings, {len(used)} unique; pages: "
          + "; ".join(f"{t}: {', '.join(p['name'] for p in v)}" for t, v in tabs.items()))
    if missing:
        print(f"  {len(missing)} layout keys without a definition (skipped): {', '.join(sorted(set(missing))[:10])}")


if __name__ == "__main__":
    main()
