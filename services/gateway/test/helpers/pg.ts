import { PostgreSqlContainer } from "@testcontainers/postgresql";

export async function startPostgres() {
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  return {
    url: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
