/**
 * Shipped templates are English; the team talks to the founder in the
 * founder's language. "auto" mirrors whatever language the founder uses.
 */
export function languageDirective(language: string): string {
  const codeRule =
    "Code, commit messages, branch names, identifiers and issue labels follow the repository's existing conventions regardless of chat language.";
  if (language === "auto") {
    return `Mirror the founder's language: write every founder-facing message (chat replies, digests, reports quoted to the founder) in the language the founder writes in. ${codeRule}`;
  }
  return `Write every founder-facing message in: ${language}. ${codeRule}`;
}
