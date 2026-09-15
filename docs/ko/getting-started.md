# 첫 CLI 만들기

[English](../getting-started.md) · 한국어 · [README](../../README.ko.md)

Node 24 이상을 사용합니다. 애플리케이션 디렉터리에서 패키지와 TypeScript 도구를 설치합니다.

```sh
npm install cli-for-ai
npm install --save-dev typescript @types/node
```

## 명령을 선언하고 실행하기

`cli.mts`를 만듭니다.

```ts
import { application, command, completed, output } from "cli-for-ai";
import { run } from "cli-for-ai/node";

const greet = command({
  summary: "Greet someone",
  input: {
    positionals: [{ name: "name", summary: "Name to greet", required: true }],
  },
  output: output<string>({ summary: "Greeting text" }),
  examples: [{ summary: "Greet Ada", input: { name: "Ada" } }],
  run: ({ name }) => completed(`Hello, ${name}`),
  human: (greeting) => greeting,
});

const app = application({
  name: "hello",
  version: "1.0.0",
  summary: "A greeting CLI",
  commands: { greet },
});

await run(app, { context: () => ({}) });
```

명령은 입력·출력·실행을 함께 선언합니다. 애플리케이션은 호출 경로를 정하고, `run`은 이를 Node의 인자·스트림·신호에 연결합니다. 이 명령은 외부 서비스가 필요하지 않아 빈 컨텍스트를 사용합니다.

Node에서 TypeScript 파일을 직접 실행합니다.

```sh
node cli.mts
node cli.mts greet --help
node cli.mts greet Ada
node cli.mts greet Ada --human
```

인자 없이 호출하면 도움말을 보여줍니다. `greet --help`는 필수 이름과 출력을 설명합니다. `greet Ada`는 다음 성공 결과를 stdout에 씁니다.

```json
{"status":"completed","data":"Hello, Ada"}
```

`--human`을 붙이면 `Hello, Ada`를 출력합니다. 두 모드의 핸들러는 같습니다. `node cli.mts greet`는 이름이 빠졌다는 오류를 stderr에 보고하고, 핸들러를 호출하기 전에 종료 코드 2로 끝납니다. 출력과 함께 종료 상태도 확인합니다.

## 타입 검사하기

Node의 TypeScript 실행은 타입 검사를 하지 않습니다. 컴파일러로 별도 검사합니다.

```sh
npx tsc --noEmit --strict --module nodenext --target es2024 cli.mts
```

반환 데이터에 런타임 검증이 필요하면 [출력 파싱](results.md#성공-데이터를-검증하고-설명하기)을 사용합니다. 위의 `output<string>`은 TypeScript 계약이며 외부 서비스의 응답을 검증하지는 않습니다.

## CLI 확장하기

- [명령](commands.md): 그룹과 재사용할 명령 구성
- [입력](inputs.md): 옵션 검증, stdin 선택, 하위 명령 인자 전달
- [결과](results.md)와 [페이로드](payloads.md): 구조화된 답 반환과 데이터 스트리밍
- [실행](execution.md): 서비스 주입, 취소 처리, 자원 해제
- [테스트](testing.md): 핸들러와 실제 호출 검증

저장소의 [노트 예제](notebook-example.md)는 영속 저장소, 설정, JSONL 내보내기를 보여줍니다. 프레임워크 자체를 수정하려면 [개발 안내](development.md)를 참고합니다.
