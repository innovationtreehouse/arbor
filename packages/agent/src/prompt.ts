export interface SlackMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
}

const AGENT_NAME = process.env.AGENT_NAME ?? "Squirrel";

export function buildSystemPrompt(): string {
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
- If you cannot find what was requested, say so clearly and suggest alternatives
- Keep responses under 3900 characters`;
}

export function buildPrompt(
  history: SlackMessage[],
  currentText: string
): string {
  // If there's no prior context, return just the current message
  if (history.length <= 1) {
    return currentText;
  }

  // All messages except the last (which is the current message being handled)
  const prior = history.slice(0, -1);
  const formatted = prior
    .map((msg) => {
      const author = msg.bot_id ? AGENT_NAME : `User <${msg.user ?? "unknown"}>`;
      return `${author}: ${msg.text ?? ""}`;
    })
    .join("\n");

  return `Thread context:\n${formatted}\n\nCurrent message:\n${currentText}`;
}
