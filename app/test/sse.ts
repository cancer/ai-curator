/**
 * テスト用: 本番の summarize.ts が消費する Workers AI ストリーミング応答（SSE）を
 * 模したストリームを作る。digest モデル（Gemma）は OpenAI 互換の choices 形式で
 * 返すため、可視回答は choices[0].delta.content に載せる。
 */
export function sseStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}
