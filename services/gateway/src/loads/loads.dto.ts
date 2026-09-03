import {
  IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, Min,
} from "class-validator";
import { Type } from "class-transformer";
import { IsRealIsoDateTime } from "./iso-date-time.validator";

// Validacao de forma (campo ausente, tipo errado, string vazia). A
// invariante de dominio (ex.: origem igual a destino, janela de coleta no
// passado) ja existe no catalog (ver services/catalog/src/load/load.service.ts)
// e nao e duplicada aqui.
//
// Excecao deliberada: `weightKg` exige inteiro positivo aqui, nao so
// inteiro. Um peso negativo e um dado estruturalmente absurdo (nao uma regra
// de negocio sutil como "janela no passado"), e testar isso especificamente
// no gateway prova que a requisicao nem chega a discar para o catalog —
// ver o teste correspondente em test/loads.e2e.spec.ts.
export class CreateLoadDto {
  @IsString()
  @IsNotEmpty()
  shipperId!: string;

  @IsString()
  @IsNotEmpty()
  origin!: string;

  @IsString()
  @IsNotEmpty()
  destination!: string;

  @IsInt()
  @IsPositive()
  weightKg!: number;

  @IsInt()
  priceCeilingCents!: number;

  @IsRealIsoDateTime()
  pickupWindowEnd!: string;
}

// Query string e sempre texto no fio HTTP: `limit` precisa de `@Type(() =>
// Number)` (class-transformer) para virar numero antes do class-validator
// avaliar `@IsInt()`. Isso so tem efeito com `transform: true` no
// ValidationPipe global (ver src/create-app.ts).
export class ListLoadsQueryDto {
  @IsOptional()
  @IsString()
  origin?: string;

  @IsOptional()
  @IsString()
  destination?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
