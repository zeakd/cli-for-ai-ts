# 명령 선언과 배치

[English](../commands.md) · 한국어 · [README](../../README.ko.md)

명령은 허용하는 입력, 출력, 실행을 정의합니다. 애플리케이션에서 붙이는 이름이 호출 경로를 결정합니다. 같은 정의를 여러 경로에 배치해도 예제를 다시 작성할 필요가 없습니다.

```ts
import { application, command, completed, group, output } from "cli-for-ai";

const count = command({
  summary: "Count items",
  input: { options: { limit: { summary: "Maximum items", type: "integer", min: 1, default: 20 } } },
  output: output<number>({ summary: "Number of items selected" }),
  examples: [{ summary: "Select at most five items", input: { limit: 5 } }],
  run: ({ limit }) => completed(limit),
});

const app = application({
  name: "sample",
  version: "1.0.0",
  summary: "Demonstrate command placement",
  commands: { count, items: group({ summary: "Item operations", commands: { count } }) },
});
```

이 예시 명령은 limit 값을 반환합니다. 실제 조회라면 [실행 컨텍스트](execution.md)를 통해 서비스를 사용합니다. 두 호출 경로는 `sample count`와 `sample items count`입니다. 중첩된 명령의 도움말에는 `sample items count --limit 5`처럼 배치된 경로로 예제를 표시합니다.

## 트리를 따라 탐색하기

애플리케이션이나 그룹을 명령 없이 호출하면 `--help`와 같은 도움말을 보여줍니다. 말단 명령은 입력 계약이 허용하면 실행합니다. 그룹은 기본 하위 명령을 실행하지 않습니다. 모르는 명령은 실패하며 가까운 이름이 있으면 후보를 제안하지만 자동 실행하지 않습니다.

`--help`는 생략한 실행 입력을 요구하지 않고 제공된 인자를 검사합니다. stdin을 읽거나 컨텍스트를 만들거나 핸들러를 호출하지 않습니다. 명령 도움말에는 입력과 출력 설명이 있고, 루트 도움말에는 공통 결과 상태와 종료 코드가 있습니다. 명령 도움말에는 루트 도움말을 여는 실행 가능한 호출도 있습니다. 해당 계약은 [결과](results.md)에서 설명합니다.

## 선언과 예제를 함께 관리하기

예제는 셸 명령 문자열이 아닌 타입이 연결된 입력값을 담습니다. 애플리케이션이 호출 문자열을 만들고, 파싱과 선언된 제약을 거친 값이 유지되는지 검사합니다. 예제에 stdin을 제공하지 않으며 검사 과정에서 핸들러를 실행하지도 않습니다. 유효한 호출 예제라는 사실만으로 설명된 작업 흐름이 올바르다고 증명되지는 않습니다.

선언은 복사한 뒤 동결하므로 원본 객체를 나중에 바꿔도 명령이 재설정되지 않습니다. 잘못된 선언은 생성 시 `AuthoringError`를 냅니다. 공유 입력의 리터럴 타입을 유지하는 방법은 [입력](inputs.md#stdin-선언-공유하기)을 참고합니다.

명령 선언은 핸들러와 관련 사용 지식 가까이에 둡니다. 현재 프레임워크는 도움말과 예제 호출을 생성하고, 작업별 스킬 작성은 애플리케이션이 맡습니다. [지원 범위](scope.md)를 참고합니다.

## 실행 중에 입력 이름 선언하기

TypeScript가 입력 이름을 알 수 있으면 `command`를 사용합니다. 설정이나 플러그인 메타데이터에서 선언을 조립한다면 `dynamicCommand`를 사용합니다.

```ts
import { completed, dynamicCommand, output, type OptionDecl } from "cli-for-ai";

function buildInspector(options: Record<string, OptionDecl>) {
  return dynamicCommand({
    summary: "Inspect a configured label",
    input: { options },
    output: output<string>(),
    run: (input) => completed(typeof input.label === "string" ? input.label : "unlabelled"),
  });
}
```

핸들러는 `Readonly<Record<string, unknown>>`을 받으므로 값을 좁힌 뒤 사용합니다. 넓은 `Record<string, OptionDecl>`에서 정적 핸들러의 리터럴 필드 이름을 얻을 수는 없으므로 이 경계에서 처리합니다. 컨텍스트와 출력의 타입은 유지합니다. 스냅샷, 선언 검증, 파싱, 도움말, 예제 검사는 동일하게 적용됩니다. stdin, 제약, 페이로드 출력도 사용할 수 있습니다. 동적이라는 말은 입력의 정적 타입을 모른다는 뜻이며 실행 검사를 생략한다는 뜻이 아닙니다.

알 수 없는 선언 키는 생성 때 실패합니다. getter를 실행하지 않으며 열거 불가 속성과 심볼 속성도 거부합니다. 일반 선언이나 [입력 헬퍼](inputs.md#선언을-공유하면서-타입-보존하기)를 재사용합니다.
