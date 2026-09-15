# 핸들러의 결과 타입 연결하기

[English](../adapters.md) · 한국어 · [README](../../README.ko.md)

코어는 자체 결과값을 받으며 결과 라이브러리를 요구하지 않습니다. 기존 서비스가 neverthrow나 Effect 값을 반환할 때 어댑터를 사용합니다. 필요한 핸들러에서 선택하며 그룹에서 상속하지 않습니다.

```ts
import { ok } from "neverthrow";
import { command, output } from "cli-for-ai";
import { fromNeverthrow } from "cli-for-ai/neverthrow";

const count = command({
  summary: "Count items",
  output: output<number>(),
  run: fromNeverthrow(() => ok(3)),
});
```

## neverthrow

`fromNeverthrow(handler, options?)`는 `Result`와 `ResultAsync`를 받습니다. 성공은 completed, 타입이 있는 오류는 failed로 바꿉니다. 오류가 코어 `Fault` 형태가 아니라면 `{ error: mapper }`를 제공합니다. 소스나 매퍼가 던진 예외는 내부 오류입니다. ResultAsync 자체에는 취소가 없으므로 실제 작업을 하는 서비스에 실행 신호를 전달합니다. 어댑터는 결과가 끝날 때까지 기다립니다.

## Effect

`cli-for-ai/effect`의 `fromEffect(handler, options?)`도 성공과 타입이 있는 실패를 같은 방식으로 매핑합니다. 소스에는 모든 Effect 서비스가 제공돼 있어야 하며(`R = never`) 기본 런타임에서 실행합니다. 단일 Fail 원인은 비즈니스 실패로 바꿀 수 있습니다. 결함·복합 원인·finalizer 실패는 내부 오류가 되고, 실행 신호가 abort된 상태에서의 interruption은 취소로 인식합니다. 호출자가 소유하는 런타임은 지원하지 않습니다.

두 어댑터 모두 일반 핸들러를 만들며 페이로드 레코드 소스를 변환하지 않습니다. 어댑터를 사용할 때 해당 라이브러리를 설치합니다. 루트 모듈은 어느 라이브러리도 import하지 않고 Node 프로세스 경계도 별도 서브패스에 있습니다. exports는 [참조](reference.md#패키지-진입점), 구현 한계는 [지원 범위](scope.md)를 참고합니다.
