// Token de injecao do cliente gRPC do bidding. Vive em arquivo proprio, e nao
// dentro de app.module.ts, pelo mesmo motivo de catalog.constants.ts:
// app.module.ts (que importa QuotesController) e quotes.controller.ts (que
// precisaria importar o token de volta de app.module.ts) nao podem formar um
// import circular entre si.
export const BIDDING_CLIENT = "BIDDING_CLIENT";
