/** インライン補完プロバイダを登録する言語（すべて登録して言語不一致を防ぐ） */
export const INLINE_COMPLETION_LANGUAGES = [
  "typescript", "javascript", "python", "java", "go", "rust", "cpp", "c", "csharp",
  "php", "ruby", "swift", "kotlin", "shell", "sql", "html", "css", "scss", "json",
  "yaml", "xml", "markdown", "dockerfile", "plaintext"
];

export function detectEditorLanguage(path: string): string {
  const lower = path.toLowerCase();

  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs")) return "javascript";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".go")) return "go";
  if (lower.endsWith(".rs")) return "rust";
  if (lower.endsWith(".cpp") || lower.endsWith(".cc") || lower.endsWith(".cxx")) return "cpp";
  if (lower.endsWith(".c") || lower.endsWith(".h")) return "c";
  if (lower.endsWith(".cs")) return "csharp";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".rb")) return "ruby";
  if (lower.endsWith(".swift")) return "swift";
  if (lower.endsWith(".kt") || lower.endsWith(".kts")) return "kotlin";
  if (lower.endsWith(".sh") || lower.endsWith(".bash") || lower.endsWith(".zsh")) return "shell";
  if (lower.endsWith(".sql")) return "sql";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss") || lower.endsWith(".sass")) return "scss";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".xml")) return "xml";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".dockerfile") || lower.endsWith("/dockerfile")) return "dockerfile";

  return "plaintext";
}

