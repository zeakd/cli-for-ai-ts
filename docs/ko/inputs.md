# 입력과 제약 선언하기

[English](../inputs.md) · 한국어 · [README](../../README.ko.md)

명령의 입력 선언은 argv를 어떻게 파싱하고 도움말에 무엇을 설명할지 결정합니다. 알 수 없는 옵션, 빠진 필수 값, 거부된 입력은 컨텍스트를 만들기 전에 실행을 중단합니다. stdin을 읽는 명령은 argv를 먼저 검사하고, stdin을 읽고 검사한 다음 컨텍스트를 생성합니다.

## 인자 문법

모르는 명령·옵션, 빠진 필수 값, 반복 불가 옵션의 중복, 초과 위치 인자는 핸들러 실행 전에 실패합니다. 남은 값을 여러 개 받는 것은 variadic을 선언한 위치 인자뿐입니다. 위치 인자 하나를 선언한 명령에서 `read a b`의 `b`를 조용히 버리지 않습니다.

긴 옵션은 `--name value` 또는 `--name=value`를 받습니다. 다음 토큰이 옵션 형태이면 값 누락 오류를 냅니다. `--cwd` 자체를 문자열로 전달하려면 `--name=--cwd`로 씁니다. 값이 빠진 옵션이 뒤의 옵션을 소비하지 않도록 하는 규칙입니다. 단독 `-`와 `-3`, `-1e3` 같은 음수 JSON 숫자는 값으로 받습니다. `-draft`, `-01`, `-3abc`는 옵션 값이면 등호 뒤에 쓰고, 일반 위치 인자이면 `--` 뒤에 씁니다. 정수 검사는 여전히 부호 있는 십진 숫자열을 받으므로 `--count=-01`은 값 `-01`을 정수 검사에 전달합니다. 전달 인자 목록을 선언한 명령이 아니라면 `--`는 옵션 파싱을 끝냅니다. 짧은 옵션과 묶음은 지원하지 않습니다. 일반 결과의 기본값은 JSON이고 `--human`으로 표현을 선택하며 내장 `--json` 플래그는 없습니다.

열거형에는 `values`, 도메인 문법에는 `pattern`이나 설명이 있는 `check`를 사용합니다. 로컬에서 알 수 있는 상태 이름 규칙은 컨텍스트 생성과 대상 조회 전에 이곳에서 검사합니다. 원격 사실이 필요한 규칙은 실행 단계에 둡니다. 숫자는 JSON 숫자 문법을 사용하고 정수는 부호 있는 십진 숫자열이며 안전한 정수 범위여야 합니다.

## 개별 값 검사하기

일반적인 제약에는 기본 제공 타입, 열거 값, 범위 선언을 사용합니다. 문자열 형식에는 `pattern`으로 정규식과 설명을 공개할 수 있습니다. 패턴은 JavaScript의 Unicode 정규식을 사용하며 값 전체가 일치해야 합니다. 일부 구간의 일치도 허용하는 JSON Schema의 `pattern`과는 의미가 다릅니다.

코드로 표현하는 편이 명확한 규칙은 사용자 정의 검사 함수로 작성할 수 있습니다.

```ts
import { check, command, completed, output } from "cli-for-ai";

const tag = command({
  summary: "Check a tag",
  input: {
    positionals: [{
      name: "tag",
      summary: "Tag to check",
      required: true,
      check: check.string("not empty or only whitespace", (value) => value.trim() !== ""),
    }],
  },
  output: output<string>(),
  run: ({ tag }) => completed(tag),
});
```

`check.string`은 검사 함수에 문자열을, `check.number`는 숫자를 전달합니다. 반복 옵션과 가변 길이 위치 인자는 각 원소를 검사합니다. 검사 함수는 동기적으로 boolean을 반환해야 합니다. false는 입력 오류이며, 예외를 던지거나 잘못된 값을 반환하면 내부 오류입니다.

도움말에는 설명을 표시합니다. 프로그램에서 호출하는 `applicationSchema(app)` API에도 사용자 정의 검사임을 표시하고 같은 설명을 포함합니다. 함수를 JSON Schema의 조건식으로 변환하지는 않습니다. 사용자 정의 검사에 실패하면 입력 이름과 기대하는 규칙을 알려주며, 받은 값을 오류에 자동으로 복사하지 않습니다.

## 입력 간 관계 검사하기

규칙이 의존하는 입력을 명시합니다. `constraints` 팩토리는 입력 이름과 콜백의 값 타입을 해당 명령의 입력 선언에 연결합니다.

```ts
const range = command({
  summary: "Select an inclusive range",
  input: {
    options: {
      from: { summary: "First index", type: "integer", required: true },
      to: { summary: "Last index", type: "integer", required: true },
    },
  },
  constraints: (rule) => [
    rule(["from", "to"], "from must not exceed to", ({ from, to }) =>
      from <= to ? undefined : "The first index exceeds the last index"),
  ],
  output: output<{ from: number; to: number }>(),
  run: ({ from, to }) => completed({ from, to }),
});
```

규칙은 입력이 유효하면 `undefined`를, 유효하지 않으면 호출자에게 보여줄 설명을 반환합니다. 규칙에는 명시한 의존 입력만 전달됩니다. 배열을 포함한 값은 읽기 전용이며, 검증 규칙이 핸들러에 전달할 입력을 변경할 수 없습니다. 선택적 입력은 콜백 안에서도 선택적입니다. 의존 입력으로 나열한다고 필수 입력이 되지는 않습니다. 오류 설명을 반환하면 입력 거부(종료 코드 2)이고, 예외를 던지거나 문자열·undefined가 아닌 값을 반환하면 내부 오류(종료 코드 70)입니다.

실행할 때는 기본값을 포함한 최종 파싱 결과를 검사합니다. 도움말에서는 모든 의존 입력을 명시적으로 제공했을 때만 규칙을 실행합니다. 따라서 `range --help`는 실행에 필요한 입력 없이도 명령을 설명할 수 있고, `range --from 8 --to 3 --help`는 잘못된 범위를 거부합니다. 기본값은 명시적으로 제공한 값으로 보지 않습니다.

도움말에는 규칙의 의존 입력과 설명을 표시하며, 프로그램에서 조회하는 스키마에도 같은 정보를 담습니다. 공개되는 오류 이유에는 호출을 어떻게 고칠지 설명하고, 자격 증명이나 가공하지 않은 서비스 응답을 넣지 않습니다.

애플리케이션 옵션의 배타 관계도 같은 규칙 팩토리로 표현할 수 있습니다.

```ts
const send = command({
  summary: "Select how to send input",
  input: {
    options: {
      keys: { summary: "Send literal key presses", type: "boolean" },
      wait: { summary: "Wait for the reply", type: "boolean" },
    },
  },
  constraints: (rule) => [
    rule(["keys", "wait"], "keys and wait cannot be combined", ({ keys, wait }) =>
      keys && wait ? "Choose either --keys or --wait" : undefined),
  ],
  output: output<null>(),
  run: () => completed(null),
});
```

이 예시는 실제 전송 없이 옵션 조합을 검사합니다. 실제 핸들러라면 검증 후 작업을 수행합니다. 프레임워크의 `--human`은 선언된 입력으로 참조할 수 없습니다.

### 기본값과 명시적 입력 구분하기

콜백의 두 번째 인자에 있는 `provided(name)`으로 직접 제공한 입력인지 확인합니다. 규칙의 의존 입력 목록에 있는 이름만 받습니다. 기본값과 같은 값을 직접 지정해도 제공한 것으로 구분합니다.

```ts
const waitForReply = command({
  summary: "Choose how long to wait",
  input: { options: {
    wait: { summary: "Wait for a reply", type: "boolean" },
    timeout: { summary: "Wait seconds", type: "integer", min: 1, default: 30 },
  } },
  constraints: (rule) => [
    rule(["timeout", "wait"], "Explicit timeout requires --wait",
      ({ wait }, { provided }) => provided("timeout") && !wait
        ? "Use --wait with --timeout" : undefined),
  ],
  output: output<number>(),
  run: ({ timeout }) => completed(timeout),
});
```

`--timeout 30`은 실패하고, `--wait`는 timeout을 직접 지정한 것으로 표시하지 않으면서 기본값 30을 사용합니다. 도움말은 여전히 모든 의존 입력이 직접 제공됐을 때만 규칙을 실행하므로 `--timeout 30 --help`에서는 이 규칙을 건너뜁니다. 규칙을 공유하려면 각 명령의 `ConstraintFactory<A>`를 받아 새 규칙을 만드는 팩토리 함수를 공유합니다. 다른 명령에서 이미 만든 규칙 객체를 재사용하지 않습니다.

## 컨텍스트를 만들기 전에 stdin 검사하기

JSON 선언은 먼저 stdin이 유효한 JSON인지 확인합니다. 선택적 형태 파서는 그 값을 검사하고, 핸들러에 전달할 형태로 정규화할 수도 있습니다.

```ts
const count = command({
  summary: "Count names read from stdin",
  input: {
    stdin: {
      format: "json",
      summary: "A JSON array of names",
      shape: {
        description: "an array containing only strings",
        parse(value: unknown) {
          if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
            return { ok: false as const, reason: "Expected an array of names" };
          }
          return { ok: true as const, value: value as string[] };
        },
      },
    },
  },
  output: output<number>(),
  run: ({ stdin }) => completed(stdin.length),
});
```

핸들러의 stdin 타입은 파서가 성공했을 때 반환하는 값에서 추론합니다. 유효하지 않은 JSON이나 명시적인 형태 검사 실패는 컨텍스트 생성 전에 종료 코드 2를 반환합니다. 파서가 예외를 던지거나 잘못된 형태의 결과를 반환하면 종료 코드 70의 내부 오류가 됩니다. 도움말은 stdin을 읽거나 형태 파서를 실행하지 않고 입력을 설명합니다.

[노트 가져오기 명령](../../examples/local-cli/src/commands/notes.ts)은 저장소에 접근하기 전에 각 태그를 포함한 전체 묶음을 검사합니다. 이후 저장소가 문서를 한 번 씁니다. 이 구조는 잘못된 입력 때문에 일부 노트만 저장되는 일을 방지합니다. 파일시스템 쓰기가 도중에 실패할 수 없다는 보장은 아닙니다.

## stdin을 읽는 조건 지정하기

`when`이 없는 stdin 선언은 매 실행마다 입력을 읽습니다. 인자로 stdin을 선택하는 명령에는 조건을 추가합니다.

```ts
const select = command({
  summary: "Select session IDs",
  input: {
    positionals: [{
      name: "id",
      summary: "Session ID, or - to read IDs from stdin",
      required: true,
    }],
    stdin: {
      when: { input: "id", equals: "-" },
      format: "text",
      summary: "Session IDs, one per line; blank lines are ignored",
    },
  },
  output: output<string[]>(),
  run: ({ id, stdin }) => completed(
    stdin === undefined
      ? [id]
      : stdin.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  ),
});
```

`when.input`은 선언된 스칼라 위치 인자나 옵션의 이름입니다. `input-file` 옵션이라면 `when: { input: "input-file", equals: "-" }`로 표현합니다. 이 선언은 stdin을 선택할 뿐, 다른 값을 파일 경로로 해석해 읽어 주지는 않습니다.

조건은 기본값과 인자 제약을 적용한 뒤의 파싱된 값을 형 변환 없이 비교합니다. 따라서 기본값이 `"-"`이면 인자를 생략해도 stdin을 선택합니다. 불리언이 아닌 인자를 기본값 없이 생략하면 값이 없으므로 조건과 일치하지 않습니다. 불리언 옵션은 `true`나 `false`와 비교할 수 있고, 반복 옵션과 가변 위치 인자는 stdin 선택에 사용할 수 없습니다. 없는 입력명, 맞지 않는 비교값 타입, 선언된 열거형에 없는 값은 명령 선언 시 거부합니다. 조건이 모든 패턴·사용자 검사·입력 간 규칙을 통과할 수 있는지까지 증명하지는 않습니다. 이 검사들은 실제 argv에 적용하며 조건 상수에 추가 실행하지 않습니다. `"-"`로 stdin을 선택한다면 입력의 패턴이나 검사도 `"-"`를 허용해야 합니다.

조건이 맞지 않으면 reader와 형태 파서를 실행하지 않고 `stdin` 키를 생략합니다. 이 키를 읽으면 `undefined`입니다. 입력 파이프가 열려 있어도 해당 호출은 기다리지 않습니다. 조건이 맞으면 EOF까지 읽고 디코딩과 검증을 마친 뒤 컨텍스트를 만듭니다. 빈 텍스트는 `undefined`가 아닌 `""`입니다. 빈 입력을 거부해야 한다면 형태 파서에서 검사합니다. 조건부 텍스트나 형태 검증을 거친 stdin은 핸들러에서 `stdin?: T`인 선택적 속성입니다. 검증하지 않은 JSON은 검증하거나 타입을 좁히기 전까지 `unknown`입니다.

도움말과 프로그램용 스키마에도 선택 조건을 표시합니다. 도움말은 제공한 인자가 stdin을 선택하더라도 읽지 않습니다. 선택된 stdin은 여전히 전부 읽으며, 읽기 조건이 스트리밍 입력을 도입하지는 않습니다.

### stdin 선언 공유하기

선언을 명령 밖의 변수에 저장한다면 조건의 입력 이름이 리터럴로 유지되게 작성합니다.

```ts
import type { StdinDecl } from "cli-for-ai";

const sessionStdin = {
  summary: "Session IDs, one per line",
  format: "text",
  when: { input: "scope", equals: "-" },
} as const satisfies StdinDecl;
```

이 선언은 스칼라 `scope` 입력이 있는 명령에 연결합니다. 넓은 `: StdinDecl` 타입 주석은 조건이 해당 명령의 입력을 가리키는지 확인하는 데 필요한 이름 정보를 지우므로 명령 조립 시 거부됩니다. 공유하는 조건부 선언에는 `as const satisfies StdinDecl`을 사용합니다. 조건 없는 선언은 `satisfies StdinDecl`만으로 형식 정보를 유지할 수 있습니다.

전체 입력에 `: InputDecl` 타입 주석을 붙인 경우도 같습니다. 현재 값에 stdin이 없어도, 그 넓은 타입은 입력 이름을 알 수 없는 조건부 stdin을 허용하므로 컴파일러가 안전한 조립을 증명할 수 없습니다. 넓은 타입 주석을 사용하던 코드에는 소스 호환성 변경입니다. 실제 키와 리터럴을 보존해 작성합니다.

```ts
import type { InputDecl } from "cli-for-ai";

const sessionInput = {
  positionals: [{ name: "scope", summary: "Session scope", required: true }],
} as const satisfies InputDecl;
```

`sessionInput`을 명령의 `input`으로 전달합니다. 인라인 선언에는 추가 주석이 필요 없습니다. 조건 오류 메시지는 현재 값이 stdin을 생략했더라도 `stdin.when`을 가리킬 수 있습니다. 현재 값이 아니라 선언된 타입이 허용하는 경우를 검사하기 때문입니다.

## 검사를 결정적으로 유지하기

검사는 전달된 값을 살펴봅니다. 네트워크에 접근하거나, 설정을 읽거나, 애플리케이션 서비스에 질의하지 않습니다. 그런 작업은 컨텍스트와 핸들러에서 수행하며, 그때의 실패는 입력 형식이 아니라 실행의 문제로 설명합니다.

`parseInvocation`은 `execute`와 같은 argv 검사를 적용합니다. 검사 함수 자체가 실패하면 `internal` 호출 판정을 반환할 수 있습니다. 이때 원래 원인은 진단용 데이터입니다. `execute`는 고정된 공개 메시지를 보고하고, 명시적으로 제공한 `onDiagnostic` 콜백에만 원래 원인을 전달합니다.

## 다른 프로그램에 인자 전달하기

자식 프로그램의 인자 목록을 따로 받으려면 `input.forward`를 선언합니다.

```ts
const preview = command({
  summary: "Preview arguments for a child program",
  input: {
    positionals: [{ name: "program", summary: "Program name", required: true }],
    forward: { name: "args", summary: "Arguments passed to the child" },
  },
  output: output<{ program: string; args: string[] }>(),
  examples: [{ summary: "Pass child options", input: { program: "worker", args: ["--model", "small"] } }],
  run: ({ program, args }) => completed({ program, args }),
});
```

이 명령을 `tool preview`에 배치했다면 `tool preview worker -- --model small`로 호출합니다. 현재 명령의 인자는 첫 `--` 앞에 있어야 합니다. 뒤의 토큰은 빈 문자열, 두 번째 `--`, `--help` 같은 플래그까지 그대로 유지합니다. 구분자 앞의 초과 인자는 컨텍스트 생성이나 자식 실행 전에 종료 코드 2로 거부합니다. 위 예시는 인자를 반환할 뿐 프로세스를 실행하지 않습니다.

구분자가 없으면 `args: []`입니다. 구분자만 있어도 빈 배열이지만 제약에서는 직접 제공한 것으로 구분합니다. forward와 variadic 위치 인자는 함께 선언할 수 없습니다. 이 명령의 `--`는 자식 인자 목록에 쓰이므로 현재 명령의 위치 인자에는 옵션 형태의 값을 표현할 수 없습니다. 단독 `-`와 음수 JSON 숫자는 표현할 수 있습니다. 예제도 같은 경계로 검사합니다.

인자를 전달한다고 자식에게 CLI의 stdout·stderr 소유권을 주지는 않습니다. 자식 출력을 수집하거나 변환해 선언한 결과 또는 페이로드로 반환합니다. 출력 형식, 백프레셔, 실패 보고는 호스트가 계속 맡습니다.

## 선언을 공유하면서 타입 보존하기

인라인 객체만으로도 충분합니다. 선언을 변수로 꺼내 공유할 때는 선택적으로 헬퍼를 사용해 리터럴 타입을 보존할 수 있습니다.

```ts
import { integer, positional, stdinText, string } from "cli-for-ai";

const limit = integer({ summary: "Maximum items", min: 1, default: 20 });
const scope = positional("scope", string({ summary: "Session scope", required: true }));
const ids = stdinText({
  summary: "Session IDs, one per line",
  when: { input: "scope", equals: "-" },
});

const sharedInput = { positionals: [scope], options: { limit }, stdin: ids };
```

`sharedInput`을 `command`에 전달합니다. `string`, `number`, `integer`, `flag`, `positional`, `stdinText`, `stdinJson`은 일반 선언을 반환하며 같은 명령 검증을 거칩니다. `string({ values, default })`는 열거형 기본값도 컴파일 때 검사합니다. 원시 객체로 쓴 기본값은 명령 생성 때 검사합니다. 헬퍼는 접근자, 심볼 키, 열거 불가 속성, 일반 객체가 아닌 값을 조용히 복사하거나 버리지 않고 거부합니다.

타입은 선언이 가질 수 있는 경우를 반영합니다. 위치 인자 튜플이나 전체 입력이 없을 수도 있다면 핸들러에서 `"scope" in input`처럼 좁힌 뒤 속성을 읽어야 합니다. 선택자와 제약은 모든 대안에서 보장되는 이름에만 의존할 수 있습니다. 넓은 값 선언은 문자열로 가정하지 않고 유니온이 됩니다. 선택적·유니온 선언의 일부 오류는 생성 때만 검출되므로 TypeScript 검사가 생성 검사를 대체하지는 않습니다. 유니온 타입을 통과한 예제라도 애플리케이션 생성 때 실제 선언과 맞지 않으면 거부됩니다.

이름을 실행 중에 조립한다면 [dynamicCommand](commands.md#실행-중에-입력-이름-선언하기)를 사용합니다.
