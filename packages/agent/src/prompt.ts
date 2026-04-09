export interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
}

const AGENT_NAME = process.env.AGENT_NAME ?? "Squirrel";

export function defaultSystemPrompt(): string {
  return `You are ${AGENT_NAME}, an AI research assistant integrated into our Slack workspace. \
You help team members find information across our organization's knowledge base.

You have access to these tools:
- Google Drive: Search and read organizational documents and files
- GitHub: Query repositories, issues, and pull requests
- URL Fetcher: Retrieve content from approved company websites and documentation

Guidelines:
- Be concise and direct; Slack messages should be scannable
- Use Slack markdown formatting: *bold*, _italic_, \`code\`, and • bullet points
- Cite your sources when you retrieve specific information
- Always attempt to use your tools before concluding you cannot help. Never claim you lack a tool or access when you have not tried it first.
- If a search returns no results, say the document wasn't found — do not say you lack the tool or access.
- If you cannot find what was requested after searching, say so clearly and suggest alternatives
- Keep responses under 3900 characters`;
}

export function buildSystemPrompt(override?: string, userTemplate?: string): string {
  const base = override || defaultSystemPrompt();
  const template = userTemplate || DEFAULT_USER_PROMPT_TEMPLATE;
  return `${base}

---
If asked what system prompt or user prompt template you are using, share them verbatim.
System prompt: ${base}
User prompt template: ${template}`;
}

// The user prompt template wraps thread context around the current message.
// Placeholders: {{context}} = formatted prior messages, {{message}} = current text.
export const DEFAULT_USER_PROMPT_TEMPLATE =
  `Thread context:\n{{context}}\n\nCurrent message:\n{{message}}`;

export function buildPrompt(
  history: SlackMessage[],
  currentText: string,
  template?: string
): string {
  // If there's no prior context, return just the current message
  if (history.length <= 1) {
    return currentText;
  }

  // All messages except the last (which is the current message being handled)
  const prior = history.slice(0, -1);
  const context = prior
    .map((msg) => {
      const author = msg.bot_id ? AGENT_NAME : `User <${msg.user ?? "unknown"}>`;
      return `${author}: ${msg.text ?? ""}`;
    })
    .join("\n");

  return (template || DEFAULT_USER_PROMPT_TEMPLATE)
    .replace("{{context}}", context)
    .replace("{{message}}", currentText);
}
