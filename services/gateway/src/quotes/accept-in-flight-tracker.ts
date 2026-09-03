// Instrumentacao de teste, desligada por padrao: conta quantas chamadas
// gRPC AcceptLoad (a chamada ao bidding dentro de QuotesController.accept)
// estao em voo ao mesmo tempo, e guarda o pico observado.
//
// Existe para test/full-flow.e2e.spec.ts provar que o SERVIDOR processou as
// tres aceitacoes simultaneas em sobreposicao real. Um timestamp
// start/end medido no lado do cliente (a primeira versao deste teste, na
// rodada de correcao 1) nao prova isso: e capturado de forma sincrona,
// antes de qualquer I/O, entao so mede quando a requisicao HTTP SAIU do
// cliente — o que a propria estrutura do teste (tres promises criadas sem
// await entre si) ja garante por construcao. Um revisor forcou o gateway a
// serializar accept() de ponta a ponta com uma fila/mutex no controller e o
// teste antigo continuou passando, porque nada nele observava o que
// acontecia depois que a requisicao saia do cliente.
//
// So conta quando ACCEPT_INFLIGHT_TRACKING=1: em qualquer outro valor
// (incluindo ausente, o caso de producao) trackAcceptRpcInFlight so chama
// fn() direto, sem nenhum overhead de contador. O codigo de producao nunca
// paga custo por isto, e o comportamento da chamada real (o que ela
// retorna, o que ela lanca) nunca muda — a instrumentacao so observa.
let current = 0;
let peak = 0;

export function resetAcceptInFlightPeak(): void {
  current = 0;
  peak = 0;
}

export function peakAcceptInFlight(): number {
  return peak;
}

export function trackAcceptRpcInFlight<T>(fn: () => Promise<T>): Promise<T> {
  if (process.env.ACCEPT_INFLIGHT_TRACKING !== "1") {
    return fn();
  }
  current += 1;
  peak = Math.max(peak, current);
  return fn().finally(() => {
    current -= 1;
  });
}
