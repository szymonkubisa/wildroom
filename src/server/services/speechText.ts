/** Spoken-text helpers for temp voices (macOS `say`) and the Director's dialogue trimmer. */

// The word count and pace are shared with the storyboard's dialogue-length check.
export { WORDS_PER_SECOND, countWords, leadingTags, secondsForLines, speakableText, withoutLeadingTags } from '../../shared/text/speech'

const POLISH_CHARS = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/
const POLISH_WORDS = /(?:^|[^\p{L}])(?:nie|jest|czy|tak|jak|dlaczego|dobrze|wszystko|tylko|teraz|gdzie|kiedy)(?=$|[^\p{L}])/iu

/** Polish diacritics or common Polish words (lines typed without diacritics still get a Polish voice). */
export function looksPolish(text: string): boolean {
  return POLISH_CHARS.test(text) || POLISH_WORDS.test(text)
}
