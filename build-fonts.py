// Advanced settings editor: OrcaSlicer's Print / Filament / Printer settings
// pages, built from settings-schema.json (tools/build-settings-schema.py).
//
// The editor never edits presets. Every change is an "override" kept by the
// page and applied on top of the selected presets when slicing, exactly like
// an unsaved modification in desktop OrcaSlicer.

const TAB_LABELS = { process: 'Print', filament: 'Filament', machine: 'Printer' };
const BOOL_TYPES = new Set(['Bool', 'Bools']);
const ENUM_TYPES = new Set(['Enum', 'Enums']);
const NUMBER_TYPES = new Set(['Float', 'Floats', 'Int', 'Ints', 'Percent', 'Percents', 'FloatOrPercent', 'FloatsOrPercents']);

export function keyTabs(schema) {
  const map = new Map();
  for (const [tab, pages] of Object.entries(schema.tabs)) {
    for (const p of pages) for (const g of p.groups) for (const o of g.options) if (!map.has(o.key)) map.set(o.key, tab);
  }
  return map;
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}

function same(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 'true';
}

export class SettingsEditor {
  /**
   * @param {HTMLElement} root  container the editor renders into
   * @param {object} schema     settings-schema.json
   * @param {object} model      { base(key), override(key), set(key, value|undefined), onChange() }
   */
  constructor(root, schema, model) {
    this.root = root;
    this.schema = schema;
    this.model = model;
    this.tab = 'process';
    this.page = {};
    this.query = '';
    this.showExpert = false;
    this.slot = 0;
    this.keyTab = keyTabs(schema);
    this.#build();
  }

  #build() {
    this.root.innerHTML = '';
    const head = el('div', 'adv-head');
    const title = el('h2', '', 'Advanced settings');
    const close = el('button', 'icon adv-close', '×');
    close.type = 'button';
    close.title = 'Close';
    close.setAttribute('aria-label', 'Close advanced settings');
    close.onclick = () => this.close();
    head.append(title, close);

    const tools = el('div', 'adv-tools');
    this.search = el('input', 'adv-search');
    this.search.type = 'search';
    this.search.placeholder = 'Search settings…';
    this.search.oninput = () => { this.query = this.search.value.trim().toLowerCase(); this.render(); };
    const expertLabel = el('label', 'adv-expert');
    this.expertBox = el('input');
    this.expertBox.type = 'checkbox';
    this.expertBox.onchange = () => { this.showExpert = this.expertBox.checked; this.render(); };
    expertLabel.append(this.expertBox, document.createTextNode(' Show expert settings'));
    // Which filament the Filament settings edit, when there are several.
    this.slotLabel = el('label', 'adv-slot');
    this.slotSelect = el('select');
    this.slotSelect.onchange = () => { this.slot = +this.slotSelect.value; this.render(); };
    this.slotLabel.append(document.createTextNode('Filament '), this.slotSelect);
    tools.append(this.search, this.slotLabel, expertLabel);

    this.tabsEl = el('div', 'tabs adv-tabs');
    for (const t of Object.keys(TAB_LABELS)) {
      const b = el('button', 'tab', TAB_LABELS[t]);
      b.type = 'button';
      b.dataset.tab = t;
      b.onclick = () => { this.tab = t; this.search.value = ''; this.query = ''; this.render(); };
      this.tabsEl.append(b);
    }
    this.body = el('div', 'adv-body');
    this.nav = el('nav', 'adv-nav');
    this.content = el('div', 'adv-content');
    this.body.append(this.nav, this.content);

    this.foot = el('div', 'adv-foot');
    this.changedText = el('span', 'hint');
    const resetTab = el('button', 'link', 'Reset this tab');
    resetTab.type = 'button';
    resetTab.onclick = () => this.resetTab(this.tab);
    const resetAll = el('button', 'link', 'Reset all changes');
    resetAll.type = 'button';
    resetAll.onclick = () => this.resetAll();
    this.foot.append(this.changedText, resetTab, resetAll);
    if (this.model.savePreset) {
      // Turns the current settings into an OrcaSlicer preset file (e.g. a custom printer).
      this.saveBtn = el('button', 'secondary adv-save', 'Save as preset file…');
      this.saveBtn.type = 'button';
      this.saveBtn.onclick = () => this.model.savePreset(this.query ? 'machine' : this.tab, this.slot);
      this.foot.append(this.saveBtn);
    }

    const note = el('p', 'hint adv-note',
      'Changes apply to your next slice. Settings in bold differ from the selected profile; ↺ puts one back.');
    this.root.append(head, tools, this.tabsEl, note, this.body, this.foot);
  }

  open(tab) {
    if (tab) this.tab = tab;
    this.root.hidden = false;
    this.render();
    this.search.focus({ preventScroll: true });
  }

  close() {
    this.root.hidden = true;
    this.root.dispatchEvent(new Event('close'));
  }

  get isOpen() {
    return !this.root.hidden;
  }

  visible(key) {
    const def = this.schema.options[key];
    if (!def) return false;
    if (!this.showExpert && (def.mode === 'expert' || def.mode === 'develop')) return false;
    return true;
  }

  label(entry) {
    const def = this.schema.options[entry.key] || {};
    const base = def.label || def.fullLabel || entry.key;
    return entry.line && entry.line !== base ? `${entry.line}: ${base}` : base;
  }

  changedKeys(tab) {
    const out = [];
    for (const p of this.schema.tabs[tab]) {
      for (const g of p.groups) for (const o of g.options) if (this.model.override(o.key) !== undefined) out.push(o.key);
    }
    return [...new Set(out)];
  }

  resetTab(tab) {
    for (const k of this.changedKeys(tab)) this.model.set(k, undefined);
    this.model.onChange();
    this.render();
  }

  resetAll() {
    for (const t of Object.keys(TAB_LABELS)) for (const k of this.changedKeys(t)) this.model.set(k, undefined);
    this.model.clearOther?.();
    this.model.onChange();
    this.render();
  }

  render() {
    if (this.root.hidden) return;
    for (const b of this.tabsEl.children) b.classList.toggle('active', b.dataset.tab === this.tab && !this.query);
    const slots = this.model.slots ? this.model.slots() : [];
    this.slot = Math.min(this.slot, Math.max(0, slots.length - 1));
    this.slotLabel.hidden = slots.length < 2 || (this.tab !== 'filament' && !this.query);
    this.slotSelect.replaceChildren(...slots.map((label, i) => new Option(label, String(i))));
    this.slotSelect.value = String(this.slot);
    this.content.innerHTML = '';
    if (this.saveBtn) {
      this.saveBtn.hidden = !!this.query;
      this.saveBtn.textContent = { machine: 'Save printer as file…', process: 'Save print settings as file…', filament: 'Save filament as file…' }[this.tab];
    }
    this.#renderCounts();
    if (this.query) {
      this.#renderSearch();
      return;
    }
    const pages = this.schema.tabs[this.tab];
    const current = pages.find((p) => p.name === this.page[this.tab]) || pages[0];
    for (const g of current.groups) this.#renderGroup(g.name, g.options);
  }

  /** Footer count and page badges; cheap, so it runs after every edit. */
  #renderCounts() {
    const changed = Object.keys(TAB_LABELS).reduce((n, t) => n + this.changedKeys(t).length, 0);
    const other = this.model.otherCount ? this.model.otherCount() : 0;
    this.changedText.textContent = (changed ? `${changed} changed setting${changed === 1 ? '' : 's'}` : 'No changes')
      + (other ? ` · ${other} more from an opened project` : '');
    this.nav.innerHTML = '';
    this.nav.hidden = !!this.query;
    if (this.query) return;
    const pages = this.schema.tabs[this.tab];
    const current = pages.find((p) => p.name === this.page[this.tab]) || pages[0];
    this.page[this.tab] = current.name;
    for (const p of pages) {
      const count = p.groups.reduce((n, g) => n + g.options.filter((o) => this.model.override(o.key) !== undefined).length, 0);
      const b = el('button', 'adv-page' + (p === current ? ' active' : ''), p.name);
      b.type = 'button';
      if (count) b.append(el('span', 'badge', String(count)));
      b.onclick = () => { this.page[this.tab] = p.name; this.render(); this.content.scrollTop = 0; };
      this.nav.append(b);
    }
  }

  #renderSearch() {
    const q = this.query;
    let hits = 0;
    for (const [tab, pages] of Object.entries(this.schema.tabs)) {
      for (const p of pages) {
        for (const g of p.groups) {
          const opts = g.options.filter((o) => {
            if (!this.visible(o.key)) return false;
            const def = this.schema.options[o.key];
            const hay = [o.key, def.label, def.fullLabel, def.tooltip, g.name, o.line].filter(Boolean).join(' ').toLowerCase();
            return q.split(/\s+/).every((w) => hay.includes(w));
          });
          if (opts.length) {
            hits += opts.length;
            this.#renderGroup(`${TAB_LABELS[tab]} › ${p.name} › ${g.name}`, opts);
          }
        }
      }
    }
    if (!hits) this.content.append(el('p', 'hint', this.showExpert ? 'No settings match.' : 'No settings match. Try "Show expert settings".'));
  }

  #renderGroup(name, options) {
    const rows = options.filter((o) => this.visible(o.key));
    if (!rows.length) return;
    const section = el('section', 'adv-group');
    section.append(el('h3', '', name));
    for (const o of rows) section.append(this.#row(o));
    this.content.append(section);
  }

  #row(entry) {
    const key = entry.key;
    const def = this.schema.options[key];
    const base = this.model.base(key);
    const override = this.model.override(key);
    const raw = override !== undefined ? override : (base !== undefined ? base : def.default);
    // Filament settings hold one value per filament; edit the chosen one.
    const idx = this.keyTab.get(key) === 'filament' && Array.isArray(raw) ? Math.min(this.slot, raw.length - 1) : 0;
    const shown = Array.isArray(raw) ? raw[idx] : raw;
    const changed = override !== undefined && (!Array.isArray(override) || !same(override[idx], Array.isArray(base) ? base[idx] : base));

    const row = el('div', 'adv-row' + (changed ? ' changed' : ''));
    const label = el('label', 'adv-label', this.label(entry));
    const id = 'adv-' + key;
    label.htmlFor = id;
    if (def.tooltip) label.title = def.tooltip;
    const field = el('div', 'adv-field');

    const commit = (value) => {
      let next = value;
      if (Array.isArray(raw)) {
        next = raw.length ? raw.slice() : [value];
        next[idx] = value;
      }
      this.model.set(key, same(next, base) ? undefined : next);
      const isChanged = Array.isArray(next) && Array.isArray(base) ? !same(next[idx], base[idx]) : !same(next, base);
      this.model.onChange();
      row.classList.toggle('changed', isChanged);
      reset.hidden = !isChanged;
      this.#renderCounts();
    };

    let input;
    if (BOOL_TYPES.has(def.type)) {
      input = el('input');
      input.type = 'checkbox';
      input.checked = truthy(shown);
      input.onchange = () => commit(input.checked ? '1' : '0');
    } else if (ENUM_TYPES.has(def.type) && def.choices) {
      input = el('select');
      const values = def.choices.map((c) => c[0]);
      for (const [v, l] of def.choices) input.append(new Option(l, v));
      if (shown !== undefined && shown !== null && !values.includes(String(shown))) input.append(new Option(String(shown), String(shown)));
      input.value = shown ?? '';
      input.onchange = () => commit(input.value);
    } else if (def.multiline) {
      input = el('textarea');
      input.rows = Math.min(14, Math.max(3, String(shown ?? '').split('\n').length + 1));
      input.value = shown ?? '';
      input.spellcheck = false;
      input.onchange = () => commit(input.value);
    } else {
      input = el('input');
      input.type = 'text';
      input.value = shown ?? '';
      if (NUMBER_TYPES.has(def.type)) {
        input.inputMode = 'decimal';
        input.classList.add('num');
      }
      input.onchange = () => {
        const v = input.value.trim();
        const err = validate(def, v);
        input.setCustomValidity(err || '');
        input.classList.toggle('invalid', !!err);
        if (err) { input.title = err; input.reportValidity(); return; }
        commit(v);
      };
    }
    input.id = id;
    if (def.readonly) input.disabled = true;
    field.append(input);
    if (def.unit && !BOOL_TYPES.has(def.type) && !def.multiline) field.append(el('span', 'unit', def.unit));
    if (def.tooltip) {
      const help = el('span', 'help', '?');
      help.title = def.tooltip;
      help.tabIndex = 0;
      help.setAttribute('role', 'note');
      help.setAttribute('aria-label', def.tooltip);
      field.append(help);
    }
    const reset = el('button', 'link reset', '↺');
    reset.type = 'button';
    const baseShown = Array.isArray(base) ? base[idx] : base;
    reset.title = 'Back to the profile value' + (baseShown !== undefined ? `: ${baseShown}` : '');
    reset.hidden = !changed;
    reset.onclick = () => {
      const cur = this.model.override(key);
      if (Array.isArray(cur) && Array.isArray(base) && cur.length === base.length) {
        const next = cur.slice();
        next[idx] = base[idx];
        this.model.set(key, same(next, base) ? undefined : next);
      } else {
        this.model.set(key, undefined);
      }
      this.model.onChange();
      row.replaceWith(this.#row(entry));
      this.#renderCounts();
    };
    field.append(reset);
    row.append(label, field);
    return row;
  }
}

function validate(def, v) {
  if (!NUMBER_TYPES.has(def.type)) return '';
  if (v === '' || v.toLowerCase() === 'nil') return '';
  const percent = /%$/.test(v);
  if (percent && !/Percent/.test(def.type)) return 'A number is needed here.';
  const n = Number(v.replace(/%$/, ''));
  if (!Number.isFinite(n)) return 'A number is needed here.';
  if (/^Int/.test(def.type) && !Number.isInteger(n)) return 'A whole number is needed here.';
  if (!percent) {
    if (def.min !== undefined && n < def.min) return `The smallest allowed value is ${def.min}.`;
    if (def.max !== undefined && n > def.max) return `The largest allowed value is ${def.max}.`;
  }
  return '';
}

function el(tag, cls = '', text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
