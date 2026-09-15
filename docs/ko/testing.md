# 선언과 실제 호출 검증하기

[English](../testing.md) · 한국어 · [README](../../README.ko.md)

입력을 통제할 수 있는 곳에서 결정을 테스트하고, 프로세스 동작은 프로세스 경계에서 테스트합니다. 상태가 있는 CLI에는 임시 홈이 유용하지만 모든 테스트나 명령의 필수 조건은 아닙니다.

## 실행에 서비스 주입하기

```ts
import assert from "node:assert/strict";
import { application, authoring, completed, execute, output } from "cli-for-ai";

type Context = { count: () => number };
const { command } = authoring<Context>();
const app = application({
  name: "counter",
  version: "1.0.0",
  summary: "Count stored items",
  commands: {
    count: command({
      summary: "Count items",
      output: output<number>(),
      run: (_input, ctx) => completed(ctx.count()),
    }),
  },
});

let created = 0;
const context = () => { created++; return { count: () => 3 }; };
const invalid = await execute(app, ["count", "extra"], { context });
assert.equal(invalid.exitCode, 2);
assert.equal(created, 0);
const result = await execute(app, ["count"], { context });
assert.deepEqual(JSON.parse(result.stdout), { status: "completed", data: 3 });
```

첫 검증은 오류 메시지만 확인하는 것이 아닙니다. 잘못된 입력이 애플리케이션의 서비스 팩토리까지 도달하지 않았음을 확인합니다. 대상 조회 없이 검증할 수 있는 잘못된 상태 이름이나 충돌 옵션에도 같은 방식을 적용합니다.

## 동작을 소유하는 경계 확인하기

| 경계 | 유용한 근거 |
| --- | --- |
| 순수 함수 | 고정 입력에 대한 예상 결정 |
| `execute` | 제한된 출력의 파싱·결과 내용·채널·효과 호출 횟수 |
| `executeTo` | 소스 완료 전 첫 출력; sink가 막혀 있는 동안 다음 레코드를 요청하지 않음 |
| 실제 프로세스 | 종료 상태, argv 전달, 열린 stdin, 신호 정리, 출력 flush |
| 빌드된 패키지 | 소스 트리 밖에서도 exports와 타입 추론 동작 |

조건부 stdin은 입력 파이프를 열어 둔 채 선택하지 않은 호출이 EOF를 기다리지 않고 종료하는지 확인합니다. 스트림은 시간 추측 대신 핸드셰이크로 소스와 sink의 진행을 제어합니다. 실패 시 일부 출력이 남을 수 있고 종료 상태가 완료로 오인시키지 않는지도 확인합니다.

노트북 테스트는 영속성에 격리된 `NOTEBOOK_HOME` 디렉터리를, 로직에는 메모리 문서 저장소를 사용합니다. 저장소를 소유하지 않는 CLI는 서비스 응답을 주입할 수 있습니다. [예제 테스트](../../examples/local-cli/test/notebook.test.ts)와 [프로세스 테스트](../../examples/local-cli/test/process.test.ts)를 참고합니다.

[네트워크 예제](../../examples/network-cli/src/repo.ts)는 fetch 함수를 주입하며, [테스트](../../examples/network-cli/test/repo.test.ts)는 외부 서비스에 의존하지 않고 가짜 응답을 사용합니다.

## 설명도 코드와 함께 검증하기

생성된 도움말과 검증된 예제 인자는 불일치를 줄이지만, 작성자가 제공한 필드 설명과 작업 흐름은 검토해야 합니다. 다음 명령이 사용하는 출력 필드를 확인하고 대표 작업 흐름을 실행합니다. 스키마 lint는 빠진 요약을 찾을 수 있지만 AI가 올바른 명령을 찾는지 증명하지는 못합니다.

저장소 검증에는 Node 24 이상을 사용합니다.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
```

Typecheck와 test는 먼저 `dist`를 빌드합니다.

## 재사용 입력 선언 검증하기

꺼내 쓴 헬퍼와 없을 수도 있는 선언을 포함해 실제 소비자 코드를 빌드된 `.d.ts`로 컴파일합니다. 올바른 타입 좁히기가 통과하고 안전하지 않은 속성 접근은 거부되는지 확인합니다. 실행 검사에서는 구분자 앞의 초과 인자가 컨텍스트나 자식 프로세스를 만들지 않고, 전달 인자는 바뀌지 않는지 확인합니다. `provided`를 쓰는 규칙은 생략과 기본값에 같은 값을 직접 지정하는 경우를 나눠 검사합니다. 도움말에서 의존 입력이 부족하면 규칙을 건너뛰는지도 확인합니다.
