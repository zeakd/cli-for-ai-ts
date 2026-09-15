# 페이로드 내보내기

[English](../payloads.md) · 한국어 · [README](../../README.ko.md)

다른 프로그램이 사용할 데이터 자체를 출력할 때 페이로드 명령을 사용합니다. 검색할 JSONL 레코드나 인자로 전달할 파일 경로가 여기에 해당합니다. 명령의 `output` 자리에 `payload.jsonl()` 또는 `payload.text()`를 둡니다. 일반 명령은 `output()`과 JSON 결과 봉투를 그대로 사용합니다.

## JSONL 레코드

```ts
import { authoring, payload, records } from "cli-for-ai";

type Block = { sessionId: string; text: string };
type Context = {
  blocks(scope: string, signal: AbortSignal): AsyncIterable<Block>;
};

const flat = authoring<Context>().command({
  summary: "Export session blocks as JSONL",
  input: {
    positionals: [{ name: "scope", summary: "Session scope", required: true }],
  },
  output: payload.jsonl<Block>({
    summary: "One session block per line",
    fields: [
      { path: "sessionId", summary: "Session containing the block" },
      { path: "text", summary: "Block text" },
    ],
  }),
  run: ({ scope }, ctx, { signal }) => records(ctx.blocks(scope, signal)),
});
```

`flat`을 애플리케이션에 배치하고 기존처럼 `cli-for-ai/node`의 `run`으로 실행합니다. Node 진입점은 레코드를 한 건씩 요청하고 출력합니다. 결과 봉투 없이 한 줄에 일반 JSON 객체 하나를 쓰며, 이 API의 JSONL 레코드로 배열이나 원시값은 받지 않습니다. 문자열 안의 개행은 JSON 이스케이프로 표현합니다. 출력은 들여쓰기로 줄을 나누지 않는 UTF-8이며, 비ASCII 문자는 그대로 보존합니다.

타입 인자는 소스의 레코드 타입을 설명합니다. 선택적 `parse(record)`는 각 레코드를 JSON으로 투영하고 인코딩하기 전에 한 번 검증하고 정규화할 수 있습니다. 파서가 없으면 TypeScript가 선언한 타입을 검사하며, 실행기는 여전히 각 런타임 레코드가 패키지의 일반 JSON 규칙으로 표현할 수 있는 객체인지 검사합니다. `fields`는 설명용 메타데이터로, 레코드를 검증하지 않습니다. 경로는 각 객체를 기준으로 `sessionId`, `tags[]`처럼 쓰며, 점이 들어 있는 키는 `["a.b"]`로 표현합니다.

## 텍스트 레코드와 구분자

```ts
import { authoring, payload, records } from "cli-for-ai";

type Context = {
  paths(signal: AbortSignal): AsyncIterable<string>;
};

const files = authoring<Context>().command({
  summary: "Print matching file paths",
  input: {
    options: {
      null: { summary: "Separate paths with NUL", type: "boolean" },
    },
  },
  output: payload.text({
    summary: "Matching paths",
    records: "file paths",
    framing: { default: "lf", nul: "null" },
  }),
  run: (_input, ctx, { signal }) => records(ctx.paths(signal)),
});
```

프레이밍 선언은 명령에 선언된 boolean 옵션을 가리킵니다. `--null`이 없으면 각 문자열 뒤에 LF를, 있으면 NUL을 붙입니다. 고정된 `framing: "lf"` 또는 `framing: "nul"`은 옵션이 필요하지 않습니다. 텍스트는 UTF-8로 인코딩하며 이스케이프하지 않습니다. 레코드에 해당 모드의 구분자가 들어 있으면 그 레코드를 쓰기 전에 실패합니다. 공백, 따옴표, 개행이 포함된 경로는 NUL 프레이밍을 `xargs -0`와 함께 사용합니다. 경로의 유효성은 애플리케이션이 판단합니다.

두 형식 모두 `maxRecordBytes`를 받습니다. 구분자를 포함한 양의 정수 바이트 수이며 기본값은 8 MiB입니다. 레코드가 제한을 넘으면 잘라내지 않고 실패합니다. 이는 인코딩된 레코드의 허용 크기이며 JavaScript 메모리의 상한이 아닙니다. 소스, 파서, JSON 투영, 직렬화 과정에서 더 많은 메모리를 할당할 수 있습니다.

## 실패와 부분 출력

핸들러는 소스를 얻기 전에 `failed(fault)`를 반환할 수 있습니다. 순회 중 애플리케이션 실패로 종료하려면 `stop(fault)`를 yield합니다.

```ts
import { records, stop } from "cli-for-ai";

async function* blocks() {
  yield { sessionId: "session-1", text: "First block" };
  yield stop({ code: "SOURCE_UNAVAILABLE", message: "The next block could not be read" });
}

const source = records(blocks());
```

`records()`는 내보내기 완료를 뜻하지 않습니다. 선언한 수신 측 종료 정책을 충족하고 정리가 끝나야 성공입니다. 기본 정책에서는 소스가 끝나고 모든 출력 쓰기도 수용되어야 합니다. `stop()`은 브랜드가 있는 제어 값이며, 비슷한 속성을 가진 일반 레코드는 그대로 레코드로 취급합니다. 예상 밖의 예외나 잘못된 JSON 레코드는 내부 실패입니다.

알 수 없는 명령 경로, 잘못된 인자, 지원하지 않는 `--human`을 포함한 모든 오류는 stderr로 보냅니다. 인자 거부는 stdin, 컨텍스트 생성, 핸들러보다 먼저 일어납니다. 선택된 stdin의 읽기와 검증도 컨텍스트 생성보다 앞섭니다.

페이로드 실패 보고는 `payload.recordsWritten`과 `payload.complete: false`를 포함한 압축 JSON 한 줄입니다. 프레임워크 진단 줄은 그 앞이나 뒤에 올 수 있습니다. [채널 계약](results.md#채널과-종료-코드)을 참고합니다. `recordsWritten`은 보고 시점의 하한으로, 실행기에 쓰기 수용이 확인된 레코드만 셉니다. 취소되거나 실패한 현재 쓰기도 레코드의 일부 또는 전부를 전달했을 수 있으며, 소유한 쓰기가 보고 이후 끝날 수도 있습니다. 개수와 쓰기 수용은 수신 측의 소비나 저장을 입증하지 않습니다. 앞선 바이트는 stdout에 남고 실패나 완료 봉투를 덧붙이지 않습니다.

### 수신 측 종료 정책 선택

`payload.jsonl`과 `payload.text` 모두 `readerClose`를 받습니다.

- `"require-full"`(기본): 수신 측 종료가 관측되면 `OUTPUT_CLOSED`, 종료 코드 70입니다. 종료 코드 0에는 소스의 자연 종료, 쓰기 수용 확인, 성공한 정리가 필요합니다.
- `"allow"`: 수신 측 종료가 관측되면 생산을 멈추고 소스에 취소를 요청합니다. iterator를 마무리한 뒤 컨텍스트를 해제합니다. 이전 실패나 호출자 중단이 우선하지 않고 정리에 성공하면 종료 코드 0입니다. API의 완료 정보는 `payload.complete: false`이며 전체 내보내기를 주장하지 않습니다. 성공 보고는 출력하지 않습니다.

전체 내보내기에는 기본값을 사용합니다. `head`나 `rg -m`으로 일부만 읽는 검색용 명령은 `readerClose: "allow"`를 선언할 수 있습니다. 이는 작성자가 정한 정책이며 수신자가 의도적으로 멈췄다는 증거는 아닙니다. 수신자 충돌도 동일하게 보일 수 있습니다. iterator 마무리나 컨텍스트 해제 실패는 여전히 종료 코드 0을 막습니다.

```ts
const paths = payload.text({
  records: "file paths",
  framing: "nul",
  readerClose: "allow",
});
```

구분자 충돌과 레코드 크기 거부는 계속 애플리케이션 실패(종료 코드 1)입니다. EOF만으로 완전성을 입증할 수 없고 생산자의 성공이 수신자의 성공을 입증하지도 않습니다. 작업의 요구에 따라 셸의 파이프라인 상태나 `pipefail`로 생산자와 수신자의 상태를 확인합니다. `payload.complete: true`에는 자연 종료, 쓰기 수용 확인, 성공한 정리가 모두 필요합니다. 소스의 모든 바이트를 썼더라도 정리에 실패하면 false일 수 있습니다.

페이로드 명령은 `human`이나 `result` 선언을 받지 않습니다. `--human`을 내보내기 전환 옵션으로 취급하지 않고 거절합니다. 도움말은 페이로드 형식, 프레이밍, 레코드 설명, 바이트 제한, 실패 계약을 보여줍니다.

## 프로그램에서 선언 조회하기

`applicationSchema(app)`는 일반 결과 명령에 `output`을, 페이로드 명령에 `payload`를 반환합니다. 두 종류가 섞인 명령 트리를 탐색하는 코드는 출력 필드를 읽기 전에 어느 쪽인지 좁혀야 합니다. 페이로드 필드 경로는 레코드를 기준으로 하며, 일반 출력 경로는 계속 `data`로 시작합니다.

프레임워크 옵션에는 `all`, `ordinary-commands`, `root` 중 하나인 `scope`가 포함됩니다. 특히 `globalOptions`에 `human`이 있다고 해서 페이로드 명령이 이를 지원하는 것은 아닙니다. `lintSchema`는 페이로드의 summary도 출력 설명으로 인정합니다.

## 실행과 자원 소유

`cli-for-ai/node`의 `run`은 `executeTo(app, argv, options)`를 사용합니다. 별도의 host에서는 `stdout`과 `stderr` sink를 제공해 이 API를 호출할 수 있습니다. 각 sink는 `write(chunk: Uint8Array, signal?: AbortSignal): Promise<void>`를 제공합니다. 쓰기를 수용했을 때만 resolve하고, 실패하면 reject하며 전달된 취소 신호를 처리해야 합니다. 취소가 오류 보고를 막지 않도록 최종 오류 보고에는 signal을 생략합니다. 항상 즉시 resolve하는 sink는 빠른 소스가 취소나 I/O 이벤트를 막지 않도록 호스트의 이벤트 루프에 실행 기회를 돌려줘야 합니다. Node sink는 이를 처리합니다. 실행기는 매번 쓰기가 끝날 때까지 기다린 뒤 다음 레코드를 요청합니다. 별도의 sink는 수신 측이 닫혔음을 `OutputClosedError`로 보고합니다. 일반 명령에서 `executeTo`는 수신 측 종료에 대한 종료 코드 정책을 host에 맡기고 실패를 `outputError`에 포함합니다. 그 외 전달 오류는 성공했을 실행의 종료 코드를 0이 아니게 만듭니다. Node host는 일반 명령이 그 외에는 성공했다면 수신 측 종료(`EPIPE` 또는 stdout의 `ENOTCONN`)를 성공으로 처리합니다. 페이로드는 선언한 `readerClose` 정책을 따릅니다.

Node runner는 스트림마다 첫 쓰기 실패를 `onDiagnostic`으로 보고하며, 실행기가 이미 보고한 오류는 중복 보고하지 않습니다. 깨진 스트림에서 실패가 반복돼도 쓰기마다 진단을 만들지는 않습니다.

`execute(app, argv, options)`는 출력을 문자열로 수집합니다. 테스트나 작은 결과에 적합하며 대규모 내보내기의 스트리밍 진입점은 아닙니다. 일반 JSON 명령도 표현하기 전에 전체 결과를 만듭니다.

소스도 데이터를 한 건씩 읽어야 합니다. 이미 읽은 배열을 async generator로 감싸도 저장소가 스트리밍으로 바뀌지는 않습니다. 노트 예제는 JSON 문서를 읽은 뒤 노트를 yield하므로, 출력 계약을 보여주는 예제이며 스트리밍 데이터베이스 reader는 아닙니다.

취소는 협조적으로 동작합니다. 소스가 끝나기 전에 관측한 취소는 소스가 정상 종료로 응답하더라도 실행 중단입니다. 소스와 쓰기가 완료된 뒤 컨텍스트 정리 중에 들어온 취소는 그 결과를 재분류하지 않지만, 종료 코드 0이 되려면 정리도 성공해야 합니다. 전달받은 signal을 소스의 작업에도 전달해야 합니다. 정리 과정은 대기 중인 소스 작업과 iterator의 마무리가 끝난 뒤 컨텍스트를 해제합니다. 소스가 취소를 무시하면 첫 신호 이후에도 대기가 계속될 수 있습니다. 두 번째 프로세스 신호는 출력 flush나 정리를 보장하지 않고 강제로 종료합니다.

Node runner는 stdout이나 stderr에 이미 대기 중인 쓰기도 소유합니다. 실행을 취소해도 그 바이트를 되돌릴 수는 없습니다. 소스 정리와 중단 보고 이후에도 소유한 모든 쓰기가 끝날 때까지 신호·오류 핸들러를 유지합니다. 따라서 읽기를 멈춘 수신자는 다시 읽거나 닫을 때까지 첫 취소를 기다리게 할 수 있으며, 두 번째 신호가 강제 종료 경로입니다. 취소된 현재 레코드는 `recordsWritten`에 포함되지 않더라도 일부 또는 전부가 전달될 수 있습니다.

Node sink는 write 콜백 뒤에 이벤트 루프로 실행 기회를 돌려줍니다. 레코드 사이에 신호를 처리할 기회를 주지만, 동기 OS 쓰기를 중간에 끊을 수는 없습니다. Node의 stdio 동작은 대상과 플랫폼에 따라 다릅니다. 파일 쓰기는 동기이며 파이프 쓰기는 POSIX에서 비동기, Windows에서 동기입니다. POSIX의 TTY 쓰기도 동기입니다. [Node의 프로세스 I/O 계약](https://nodejs.org/docs/latest-v24.x/api/process.html#process_a_note_on_process_io)을 참고합니다.

설계 이유와 수신 측의 완료 확인 요구는 [가이드의 출력 계약](https://github.com/zeakd/cli-for-ai-guide/blob/main/guide/ko/04-results-and-presentation.md)을 참고합니다.

일반적인 컨텍스트 수명주기와 host 선택은 [실행](execution.md)을 참고합니다.
