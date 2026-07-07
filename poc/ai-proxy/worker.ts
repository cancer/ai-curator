interface Env {
  AI: Ai;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("POST { model, input } expected", { status: 405 });
    }
    const { model, input } = (await request.json()) as { model: string; input: unknown };
    const result = await env.AI.run(model as Parameters<Ai["run"]>[0], input as never);
    return Response.json(result);
  },
};
