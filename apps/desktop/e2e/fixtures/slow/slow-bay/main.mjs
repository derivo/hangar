// E2E fixture: a bay whose start takes a while, so a second add arrives during it.
export default {
  async activate(ctx) {
    globalThis.__slowActivations = (globalThis.__slowActivations ?? 0) + 1;
    await new Promise((r) => setTimeout(r, 500));
    ctx.provide('ping', () => 'pong');
  },
};
