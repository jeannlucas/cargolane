import {
  ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger,
} from "@nestjs/common";
import { status as GrpcStatus } from "@grpc/grpc-js";
import type { Response } from "express";

// Forma do erro que atravessa um ClientGrpc do @nestjs/microservices: o
// client-proxy do Nest repassa o grpc.ServiceError cru (ver
// serializeError em node_modules/@nestjs/microservices/client/client-proxy.js),
// entao o que chega aqui como excecao rejeitada por uma chamada gRPC tem
// `code` numerico e `details`/`message` de texto, sem envelope proprio do
// Nest.
interface GrpcLikeError {
  code: number;
  details?: string;
  message?: string;
}

function isGrpcLikeError(error: unknown): error is GrpcLikeError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "number"
  );
}

// Mapa deliberadamente pequeno: so os codigos que os servicos gRPC do
// projeto realmente emitem (catalog hoje; bidding a partir da Task 6, que
// reusa este mesmo filtro). Qualquer codigo fora do mapa cai no default
// (INTERNAL_SERVER_ERROR), que e a postura conservadora certa para um codigo
// gRPC que este gateway ainda nao sabe classificar.
const GRPC_TO_HTTP_STATUS: Partial<Record<number, HttpStatus>> = {
  [GrpcStatus.INVALID_ARGUMENT]: HttpStatus.BAD_REQUEST,
  [GrpcStatus.NOT_FOUND]: HttpStatus.NOT_FOUND,
  [GrpcStatus.ALREADY_EXISTS]: HttpStatus.CONFLICT,
  [GrpcStatus.FAILED_PRECONDITION]: HttpStatus.CONFLICT,
};

// Filtro de excecao generico: traduz o codigo gRPC de um servico downstream
// para o status HTTP equivalente. Generico e nao acoplado a "loads" de
// proposito — a Task 6 (rotas REST do bidding) reusa exatamente este filtro
// para os proprios erros do bidding (ex.: ALREADY_EXISTS de uma cotacao
// duplicada), sem precisar duplicar nem estender esta classe.
@Catch()
export class GrpcErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(GrpcErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    // HttpException (ex.: BadRequestException lancada pelo ValidationPipe)
    // ja carrega o status e o corpo corretos; repassa-la intacta, sem
    // reinterpretar como se fosse um erro de origem gRPC.
    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (isGrpcLikeError(exception)) {
      const mappedStatus = GRPC_TO_HTTP_STATUS[exception.code];

      // `exception.details`/`.message` so e seguro devolver ao cliente HTTP
      // quando o codigo esta no mapa (INVALID_ARGUMENT/NOT_FOUND/
      // ALREADY_EXISTS/FAILED_PRECONDITION): esses sao erros de dominio,
      // com mensagem pensada para quem chamou (ex.: "load x not found").
      // Um codigo fora do mapa (UNAVAILABLE, INTERNAL, DEADLINE_EXCEEDED,
      // ...) normalmente carrega detalhe de infraestrutura do driver gRPC —
      // endereco e porta do servico downstream, motivo de conexao recusada
      // — que nao e problema do cliente HTTP e nao pode vazar para fora do
      // processo so porque o catalog caiu ou a rede particionou. Nesse
      // caso o corpo da resposta e sempre generico; o detalhe real vai para
      // o log do servidor, que e onde ele serve para alguma coisa.
      if (mappedStatus === undefined) {
        this.logger.error(
          `unmapped grpc error code=${exception.code}: ` +
            `${exception.details ?? exception.message ?? "no message"}`,
        );
        response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: "internal server error",
        });
        return;
      }

      response.status(mappedStatus).json({
        statusCode: mappedStatus,
        message: exception.details || exception.message || "unexpected upstream error",
      });
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: "internal server error",
    });
  }
}
