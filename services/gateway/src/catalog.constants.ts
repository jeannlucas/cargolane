// Token de injecao do cliente gRPC do catalog. Vive em arquivo proprio, e nao
// dentro de app.module.ts, para app.module.ts (que importa LoadsController)
// e loads.controller.ts (que precisaria importar o token de volta de
// app.module.ts) nao formarem um import circular entre si.
export const CATALOG_CLIENT = "CATALOG_CLIENT";
