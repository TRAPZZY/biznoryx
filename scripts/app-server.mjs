import { createReviewApp } from '../src/webapp/review-app.mjs';

const port = Number(process.env.PORT ?? 4174);
const { server, runtime } = createReviewApp();

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`BIZNORYX app running at http://127.0.0.1:${port}\n`);
  process.stdout.write(`Review sign-in: ${runtime.reviewAccount.email} / ${runtime.reviewAccount.password}\n`);
});

function shutdown(signal) {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();

  server.close(() => {
    process.stdout.write(`BIZNORYX app stopped after ${signal}.\n`);
    process.exit(0);
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
