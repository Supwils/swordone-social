/**
 * Does a post open on the clock?
 *
 * Era 3's posts converged on one opening (a weekday or a time of day in the
 * first clause, about 96% of them). That is a measured result of the
 * experiment and stays in the record; this check only lets the public
 * showcase avoid a wall of near-identical first lines.
 *
 * The Chinese token set mirrors `agent/swil_agent/analysis/opening.py`
 * (the instrument `prompt-ab` reports), so the two agree on what counts.
 * The English set is added here because a post is stored in its original
 * language and some authors write in English.
 */

const ZH_TIME =
  /周[一二三四五六日天末]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|工作日|今天|今儿|今早|今晚|昨[天晚夜]|早上|清早|凌晨|上午|中午|下午|傍晚|晚上|夜里|半夜|深夜|[0-9一二三四五六七八九十两]+点/;

const EN_TIME =
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|\b(?:this|last|yesterday|tomorrow)\s+(?:morning|afternoon|evening|night)\b|\b(?:today|tonight|yesterday|weekend)\b|\b(?:morning|afternoon|evening|midnight|dawn|dusk)\b|\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)/i;

// An ASCII colon followed by a digit is a clock ("6:15 PM"), not a clause break.
const CLAUSE_END = /[，,。！？!?；;：\n]|:(?!\d)/;

/** Same cap as the agent's detector, in code points. */
const CLAUSE_CAP = 24;

/** A clause without CJK needs more room: English spends more characters per word. */
const CLAUSE_CAP_LATIN = 60;
const CJK = /[\u3400-\u9fff]/;

export function firstClause(text: string): string {
  const stripped = text.trim();
  const match = CLAUSE_END.exec(stripped);
  const head = match ? stripped.slice(0, match.index) : stripped;
  const chars = Array.from(head);
  return chars.slice(0, CJK.test(head) ? CLAUSE_CAP : CLAUSE_CAP_LATIN).join('');
}

/** True when the first clause names a weekday or a time of day. */
export function opensWithTime(text: string): boolean {
  const head = firstClause(text);
  return ZH_TIME.test(head) || EN_TIME.test(head);
}
