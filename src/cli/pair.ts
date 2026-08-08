/**
 * Interactive Telegram pairing: guides the founder through BotFather, captures
 * the chat id from the first message, and proves the channel with a hello.
 * Testable: I/O and API base are injected.
 */

export interface PairIo {
  ask(question: string): Promise<string>;
  say(line: string): void;
}

export interface PairResult {
  botToken: string;
  chatId: string | number;
  botUsername: string;
}

interface TgResponse<T> {
  ok: boolean;
  description?: string;
  result?: T;
}

async function tg<T>(apiBase: string, token: string, method: string): Promise<T> {
  const res = await fetch(`${apiBase}/bot${token}/${method}`);
  const data = (await res.json()) as TgResponse<T>;
  if (!data.ok || data.result === undefined) {
    throw new Error(`telegram ${method} failed: ${data.description ?? res.status}`);
  }
  return data.result;
}

export async function pairTelegram(
  io: PairIo,
  opts: { apiBase?: string; projectName: string; maxWaitMs?: number } ,
): Promise<PairResult> {
  const apiBase = opts.apiBase ?? "https://api.telegram.org";

  io.say("");
  io.say("Telegram pairing");
  io.say("  1. Open Telegram and talk to @BotFather");
  io.say("  2. Send /newbot and follow the prompts (any name; username must end in 'bot')");
  io.say("  3. BotFather replies with an HTTP API token — paste it here");
  io.say("");
  const botToken = (await io.ask("Bot token: ")).trim();
  if (!botToken) throw new Error("No token entered — pairing aborted.");

  const me = await tg<{ username?: string }>(apiBase, botToken, "getMe");
  const botUsername = me.username ?? "your_bot";
  io.say(`Token OK — bot @${botUsername}.`);
  io.say(`Now open https://t.me/${botUsername} and send it any message (e.g. "hi").`);
  io.say("Waiting for your message...");

  const deadline = Date.now() + (opts.maxWaitMs ?? 120_000);
  let chatId: string | number | undefined;
  let firstName = "";
  let offset = 0;
  while (Date.now() < deadline && chatId === undefined) {
    const updates = await tg<
      { update_id: number; message?: { chat?: { id: number | string; first_name?: string } } }[]
    >(apiBase, botToken, `getUpdates?offset=${offset}&timeout=10`);
    for (const u of updates) {
      offset = u.update_id + 1;
      if (u.message?.chat) {
        chatId = u.message.chat.id;
        firstName = u.message.chat.first_name ?? "";
      }
    }
  }
  if (chatId === undefined) {
    throw new Error(
      "No message arrived in time. Run \"fh init\" again when you're ready to send one.",
    );
  }
  io.say(`Got it — chat ${chatId}${firstName ? ` (${firstName})` : ""}.`);

  // Prove the outbound path end to end.
  const send = await fetch(`${apiBase}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ founder-helpers connected to "${opts.projectName}". Your team reports here from now on.`,
    }),
  });
  const sendData = (await send.json()) as TgResponse<unknown>;
  if (!sendData.ok) {
    throw new Error(`Confirmation message failed: ${sendData.description ?? send.status}`);
  }

  return { botToken, chatId, botUsername };
}
