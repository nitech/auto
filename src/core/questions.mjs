/**
 * Answering a question the agent put to a person.
 *
 * Cursor's `ask_question` card is not an approval: it holds real options, often
 * several questions, sometimes more than one answer to one of them. The phone
 * names those options with letters so a tap or a typed "A" / "1B" can pick one
 * without guessing at Skip and Continue. Mapping that choice back to the labels
 * Cursor printed is how the window gets pressed.
 */

/** "A", or "1A" when the card holds more than one question. */
export function optionLetter(questionIndex, optionIndex, questionCount) {
  const letter = String.fromCharCode(65 + optionIndex);
  return questionCount > 1 ? `${questionIndex + 1}${letter}` : letter;
}

/** The labels Cursor shows for these selections, in the order they were picked. */
export function labelsForAnswer(questions, selections) {
  const labels = [];
  for (const q of questions || []) {
    for (const id of selections?.[q.id] || []) {
      const opt = (q.options || []).find((o) => o.id === id);
      if (opt?.label) labels.push(String(opt.label));
    }
  }
  return labels;
}

/**
 * Read a typed answer to a question card.
 *
 * Options are lettered on the phone: "A", "B", or "1A 2C" when the card holds
 * several questions. "Skip" skips. Anything else is not an answer — it is a
 * message, and must go through as one, or a thought that happened to start
 * with a letter would vanish into the question.
 *
 * @returns {{ skip: boolean, selections: Record<string, string[]> } | null}
 */
export function parseQuestionReply(text, questions) {
  const raw = String(text || '').trim();
  if (!raw || !questions?.length) return null;
  if (/^skip$/i.test(raw)) return { skip: true, selections: {} };

  const token = /^(\d+)?([A-Za-z])$/;
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  if (!parts.length || parts.some((p) => !token.test(p))) return null;

  const many = questions.length > 1;
  const selections = {};
  for (const part of parts) {
    const [, num, letter] = part.match(token);
    const qi = num ? Number(num) - 1 : 0;
    if (!Number.isInteger(qi) || qi < 0 || qi >= questions.length) return null;
    // "A" with several questions is ambiguous; the number is what makes "1A" a pick.
    if (many && !num) return null;
    const oi = letter.toUpperCase().charCodeAt(0) - 65;
    const q = questions[qi];
    const opt = q.options?.[oi];
    if (!opt) return null;
    if (!q.multiple && selections[q.id]?.length) return null;
    const already = selections[q.id] || [];
    if (!already.includes(opt.id)) already.push(opt.id);
    selections[q.id] = already;
  }
  return { skip: false, selections };
}
