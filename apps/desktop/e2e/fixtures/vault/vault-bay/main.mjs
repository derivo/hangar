// E2E fixture: a second bay whose functions agents of the agent bay call.
export default {
  activate(ctx) {
    // A badge set before Hangar's window exists must not fail the start.
    ctx.setBadge(0);
    ctx.provide('secret.read', () => 'geheim');
    ctx.provide('entry.count', () => 3);
  },
};
