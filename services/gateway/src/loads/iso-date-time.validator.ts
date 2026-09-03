import { registerDecorator, ValidationArguments, ValidationOptions } from "class-validator";

// Formato ISO 8601 completo (data + hora + offset). "pickupWindowEnd"
// representa um instante especifico (o fim de uma janela de coleta), entao
// exige-se hora e offset explicitos ("Z" ou "+HH:mm"/"-HH:mm"), no mesmo
// formato ja usado em toda a base (ex.: "2026-09-30T12:00:00Z" nos fixtures
// do catalog).
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1];
}

// Verifica formato ISO 8601 e, alem do formato, que a data e a hora
// correspondem a um instante real do calendario.
//
// `new Date("2026-02-30T12:00:00Z")` nao lanca erro nem produz um Date
// invalido: o JS rola em silencio para 1 de marco (achado conhecido deste
// projeto). O regex sozinho tambem nao pega esse caso — "2026-02-30" bate no
// formato normalmente, so nao existe no calendario.
//
// Por isso a validacao nao passa pelo construtor `Date` em nenhum momento:
// os componentes (ano/mes/dia/hora/min/seg) sao extraidos do texto por regex
// e checados por aritmetica de calendario pura. Um round-trip via
// `new Date(value)` comparando os componentes lidos de volta foi cogitado e
// descartado: uma data valida com offset diferente de "Z" pode cruzar a
// meia-noite ao ser convertida para UTC internamente pelo `Date`, o que
// faria os componentes lidos de volta (em UTC) parecerem "diferentes" do
// texto original mesmo para uma data real e valida — um falso positivo pior
// que o problema que a checagem tenta resolver.
export function isRealIsoDateTime(value: string): boolean {
  const match = ISO_DATE_TIME.exec(value);
  if (!match) {
    return false;
  }
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  if (month < 1 || month > 12) {
    return false;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return false;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return false;
  }
  return true;
}

// Decorator class-validator para uso direto em DTOs, ex.:
// `@IsRealIsoDateTime() pickupWindowEnd!: string;`.
export function IsRealIsoDateTime(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: "isRealIsoDateTime",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === "string" && isRealIsoDateTime(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a valid ISO 8601 date-time referring to a real calendar date`;
        },
      },
    });
  };
}
