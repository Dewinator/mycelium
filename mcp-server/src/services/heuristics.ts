/**
 * Heuristic encoding scorer.
 *
 * When openClaw calls `remember` without explicit importance/valence/arousal,
 * we estimate them from textual signals. This is intentionally cheap (regex,
 * no LLM) — the goal is to get the cognitive model out of its default-0.5
 * equilibrium so the salience/decay machinery actually does work.
 *
 * Signals are deliberately conservative: a normal sentence stays near defaults,
 * only marked-up content (deadlines, exclamations, emotional words, dates,
 * numbers) moves the dials.
 */

export interface EncodingSignals {
  importance: number; // 0..1
  valence: number; // -1..1
  arousal: number; // 0..1
  decay_tau_days: number; // memory half-life parameter (default 30)
  ephemeral: boolean; // true = one-time instruction, should fade fast
}

// German has heavy inflection ("kritischer", "wichtige") so we use stem matching
// without trailing word boundaries. False positives are acceptable in v1.
const KW_IMPORTANT =
  /(wichtig|kritisch|essentiell|essenziell|immer\b|niemals|nie\b|deadline|termin|frist|geheim|passwort|merk dir|nicht vergessen|denk dran|achtung|warnung|geburtstag|jahrestag|adresse|telefon|important|critical|never|always|remember|secret|password|birthday)/i;

const KW_POSITIVE =
  /(gut\b|toll|super|liebe|mag\b|freude|gelungen|erfolg|perfekt|großartig|froh\b|glücklich|zufrieden|stolz|dankbar|erleichtert|hoffnungsvoll|zuversichtlich|love|great|happy|awesome|thanks?|danke|grateful|proud|relieved|hopeful|satisfied)/i;

const KW_NEGATIVE =
  /(schlecht|hass|fehler|problem|bug|kaputt|schlimm|wütend|traurig|frustriert|mist\b|enttäuscht|verärgert|ängstlich|besorgt|überfordert|verzweifelt|gekränkt|angespannt|einsam|hate|broken|terrible|awful|angry|sad\b|annoying|frustrated|wrong|disappointed|hurt\b|anxious|worried|overwhelmed|lonely)/i;

const KW_INTENSE =
  /(sehr\b|extrem|riesig|enorm|völlig|absolut|unbedingt|sofort|dringend|asap|urgent|extremely|absolutely|immediately)/i;

const RE_DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/;
const RE_NUMBER = /\b\d+[€$%]|\b\d{3,}\b/;
const RE_CAPS = /\b[A-ZÄÖÜ]{3,}\b/;

// ---------------------------------------------------------------------------
// Ephemeral (one-time instruction) detection
//
// Goal: a concrete imperative like "stoppe den cron job" should decay fast
// once the action is done — long-term memory is for facts, preferences, and
// rules, not for operational commands. We detect this via action-verb +
// operational-object co-occurrence, suppressed by any policy/preference
// marker that would upgrade the sentence to a rule ("ab jetzt", "immer",
// "wir nutzen", "bevorzugt", ...).
// ---------------------------------------------------------------------------

const RE_ACTION_VERB =
  /\b(stopp\w*|start\w*|lösch\w*|entfern\w*|deaktivier\w*|aktivier\w*|installier\w*|deinstallier\w*|bau\w*|erstell\w*|schreibe?\w*|öffne?\w*|schließe?\w*|push\w*|pull\w*|committ\w*|commit\w*|merge\w*|mergt|deploy\w*|restart\w*|reboot\w*|kill\w*|beend\w*|abbrech\w*|abgebrochen|cancel\w*|ausführ\w*|ausgeführt|führe?\w* aus\b|run\b|running|ran\b|stop(ped|ping|s)?\b|delet\w*|remov\w*|build\w*|built\b|create[sd]?\b|created\b|writ\w*|wrote|open\w*|close[sd]?\b|disabl\w*|enabl\w*|install\w*|uninstall\w*|kill(ed|ing|s)?\b|fix\w*|fixt\b|update[sd]?\b|updated\b|upgrad\w*|downgrad\w*|renam\w*|umbenenn\w*|umbenannt|verschieb\w*|verschoben|mov\w*|copy\w*|kopier\w*|reset\w*|clear\w*|flush\w*|purg\w*|drop\w*|trigger\w*)\b/i;

const RE_OPERATIONAL_OBJECT =
  /\b(cron\s*jobs?|cronjobs?|job\b|container|docker|service|daemon|script|skript|file\b|dateien?|prozess\w*|process\w*|pod\b|branch\w*|pull\s*request|prs?\b|migration\w*|table\w*|tabelle\w*|index\b|schema\w*|endpoint\w*|server\w*|quer(y|ies)|abfragen?|tool\w*|paket\w*|package\w*|dependenc\w*|abhängigkeit\w*|module?\w*|modul\w*|cache\w*|log\w*|builds?\b|release\w*|version\w*|tests?\b|lint\w*|pipeline\w*|workflow\w*|task\w*|aufgaben?|ticket\w*|issue\w*|session\w*|account\w*|datenbank\w*|database\w*|backup\w*|snapshot\w*|image\w*|volume\w*|env\b|environment|config\w*|secret\w*|token\w*|key\w*|credential\w*|deploy\w*|deployment\w*)\b/i;

const RE_POLICY_OR_PREFERENCE =
  /(immer\b|niemals\b|\bnie\b|ab jetzt\b|ab sofort\b|von nun an\b|in zukunft\b|generell\b|grundsätzlich\b|regel\b|regelmäßig|policy|rules?\b|always\b|never\b|from now on\b|going forward\b|bevorzug\w*|prefer\w*|\bmag\b|mögen\b|liebt\b|hasst\b|standard\b|default\w*|wir nutzen\b|wir verwend\w*|wir setzen\b|we use\b|we prefer\b|we chose\b|wir haben uns entschieden|convention\w*|konvention\w*)/i;

function looksEphemeral(text: string): boolean {
  if (RE_POLICY_OR_PREFERENCE.test(text)) return false;
  return RE_ACTION_VERB.test(text) && RE_OPERATIONAL_OBJECT.test(text);
}

export function scoreEncoding(text: string): EncodingSignals {
  const t = text.trim();
  if (!t) {
    return { importance: 0.5, valence: 0, arousal: 0, decay_tau_days: 30, ephemeral: false };
  }

  // -- Importance ------------------------------------------------------------
  let importance = 0.5;
  if (KW_IMPORTANT.test(t)) importance += 0.25;
  if (RE_DATE.test(t)) importance += 0.10;
  if (RE_NUMBER.test(t)) importance += 0.05;
  if (RE_CAPS.test(t)) importance += 0.10;
  if (t.length > 200) importance += 0.05;
  if (t.length > 500) importance += 0.05;

  // -- Valence ---------------------------------------------------------------
  let valence = 0;
  if (KW_POSITIVE.test(t)) valence += 0.4;
  if (KW_NEGATIVE.test(t)) valence -= 0.4;

  // -- Arousal ---------------------------------------------------------------
  let arousal = 0;
  const exclamations = (t.match(/!/g) ?? []).length;
  arousal += Math.min(exclamations * 0.15, 0.4);
  if (KW_INTENSE.test(t)) arousal += 0.3;
  if (RE_CAPS.test(t)) arousal += 0.2;
  // Strong negative emotion is itself arousing
  if (KW_NEGATIVE.test(t)) arousal += 0.15;

  // -- Ephemeral override ----------------------------------------------------
  // One-time operational commands collapse both importance and decay horizon.
  // This overrides the keyword-boosted importance above: "wichtig: stoppe
  // cron X" is still a one-off action, not a fact to memorize.
  let decay_tau_days = 30;
  const ephemeral = looksEphemeral(t);
  if (ephemeral) {
    importance = 0.1;
    decay_tau_days = 2;
  }

  return {
    importance: clamp(importance, 0, 1),
    valence: clamp(valence, -1, 1),
    arousal: clamp(arousal, 0, 1),
    decay_tau_days,
    ephemeral,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}
