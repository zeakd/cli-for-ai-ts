# cli-for-ai

[English](README.md) · 한국어

AI 에이전트가 기능을 찾고 호출하며 다음 명령으로 결과를 전달할 수 있는 CLI를 만듭니다. 입력·실행·출력을 함께 선언해 명령이 바뀔 때 도움말과 검증도 일치하게 유지합니다. 도구를 만드는 에이전트도 그 선언을 읽고 수정하기 쉽도록 하는 것을 목표로 합니다.

일반 결과는 JSON이 기본이고 페이로드 명령은 다른 프로그램으로 레코드를 직접 흘려보낼 수 있습니다. 서비스는 컨텍스트로 주입하므로 프로세스를 시작하거나 홈 디렉터리를 만들지 않고 명령을 테스트할 수 있습니다. 설계 이유는 [cli-for-ai-guide](https://github.com/zeakd/cli-for-ai-guide/blob/main/README.ko.md)에서 설명합니다.

## 명령을 선언하고 동작 확인하기

```ts
import { application, command, completed, output } from "cli-for-ai";
import { run } from "cli-for-ai/node";

const greet = command({
  summary: "Greet someone",
  input: {
    positionals: [{ name: "name", summary: "Name to greet", required: true }],
  },
  output: output({
    summary: "A greeting",
    fields: [{ path: "data", summary: "Greeting text" }],
    parse(value: unknown) {
      if (typeof value !== "string") throw new TypeError("Expected a greeting");
      return value;
    },
  }),
  examples: [{ summary: "Greet Ada", input: { name: "Ada" } }],
  run: ({ name }) => completed(`Hello, ${name}`),
  human: (greeting) => greeting,
});

const app = application({
  name: "hello",
  version: "1.0.0",
  summary: "A small greeting CLI",
  commands: { greet },
});

await run(app, { context: () => ({}) });
```

일반 호출은 JSON 결과를 반환합니다.

```json
{"status":"completed","data":"Hello, Ada"}
```

`hello greet Ada --human`은 `Hello, Ada`를 출력합니다. 두 형태 모두 같은 핸들러를 실행합니다. `hello`와 `hello --help`는 같은 루트 도움말을 보여줍니다. `hello greet`는 핸들러를 실행하지 않고 빠진 인자를 보고합니다.

같은 선언에서 생성한 루트 도움말의 첫 부분입니다.

```text
hello 1.0.0 — A small greeting CLI

Usage:
  hello <command> [options]

Commands:
  greet  Greet someone
```

## 설치

Node 24 이상을 사용합니다.

```sh
npm install cli-for-ai
```

TypeScript를 사용한다면 `typescript`와 `@types/node`를 개발 의존성으로 설치합니다.
[첫 CLI 만들기](docs/ko/getting-started.md)에서 `cli.mts`를 작성하고 실행할 수 있습니다.
프레임워크 개발과 저장소 예제 실행은 [개발 안내](docs/ko/development.md)를 참고합니다.

## 문서

| 작업 | 읽을 문서 |
| --- | --- |
| 명령과 도움말 배치 | [명령](docs/ko/commands.md) |
| 인자 검증·전달과 stdin 선택 | [입력](docs/ko/inputs.md) |
| 상태·오류·사람용 출력 보고 | [결과](docs/ko/results.md) |
| JSONL·텍스트를 파이프로 전달 | [페이로드](docs/ko/payloads.md) |
| 서비스 주입·취소·정리 | [실행](docs/ko/execution.md) |
| 핸들러와 실제 호출 테스트 | [테스트](docs/ko/testing.md) |
| neverthrow·Effect 사용 | [어댑터](docs/ko/adapters.md) |
| API와 기본값 조회 | [참조](docs/ko/reference.md) |

지원 동작과 한계는 [구현 지원 범위](docs/ko/scope.md)를 참고합니다. [로컬](examples/local-cli)·[네트워크](examples/network-cli) 예제에는 실행 가능한 명령과 테스트가 있습니다. 개발 검증 명령은 [테스트](docs/ko/testing.md)에 있습니다.

라이선스: [MIT](LICENSE).
