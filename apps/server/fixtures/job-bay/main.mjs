// Test bay for apps/server: answers its jobs with a fixed text.
export default {
  activate(ctx) {
    ctx.jobs.onRun((job) => `done ${job.payload.n}`);
  },
};
