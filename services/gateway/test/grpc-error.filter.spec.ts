import { ArgumentsHost, Logger } from "@nestjs/common";
import { GrpcErrorFilter } from "../src/grpc-error.filter";

// Teste unitario (sem subir app nem gRPC): o objetivo e isolar exatamente o
// branch de excecao que nao e HttpException nem tem a forma de um erro gRPC
// — um bug de programacao real no gateway (ex.: TypeError de um `.map` sobre
// `undefined`, o proprio C-1 desta rodada) — e confirmar que ele passa pelo
// logger antes de responder. Antes desta correcao, esse branch devolvia 500
// sem nenhuma chamada ao logger, entao um bug no codigo do gateway nao
// deixava rastro nenhum.
function buildHost(res: { status: jest.Mock; json: jest.Mock }): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

describe("GrpcErrorFilter", () => {
  it("registra no logger um erro nao-gRPC antes de devolver 500 generico", () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const filter = new GrpcErrorFilter();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = buildHost({ status, json });

    const bug = new TypeError("Cannot read properties of undefined (reading 'map')");
    filter.catch(bug, host);

    expect(errorSpy).toHaveBeenCalled();
    const [message, stack] = errorSpy.mock.calls[0] as [string, string | undefined];
    expect(message).toContain(bug.message);
    expect(stack).toBe(bug.stack);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      statusCode: 500,
      message: "internal server error",
    });

    errorSpy.mockRestore();
  });

  it("registra no logger mesmo quando a excecao nao e uma instancia de Error", () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const filter = new GrpcErrorFilter();
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = buildHost({ status, json });

    filter.catch("uma string qualquer lancada como excecao", host);

    expect(errorSpy).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(500);

    errorSpy.mockRestore();
  });
});
