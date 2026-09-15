# 일반 결과 보고하기

[English](../results.md) · 한국어 · [README](../../README.ko.md)

작업에 대한 구조화된 답이 필요할 때 일반 결과를 사용합니다. JSONL 레코드나 NUL로 구분한 경로 목록처럼 stdout 자체가 다른 프로그램에 전달할 데이터라면 [페이로드](payloads.md)를 사용합니다.

## 확인한 상태를 반환하기

일반 핸들러는 `completed(data)`, `accepted(data)`, `failed(fault)`를 직접 또는 Promise로 반환합니다. accepted는 접수됐지만 아직 완료되지 않은 작업입니다. 실패는 오류가 보고됐다는 뜻이며 아무 작업도 일어나지 않았다는 증거는 아닙니다.

```ts
import { command, completed, output } from "cli-for-ai";

const status = command({
  summary: "Report readiness",
  output: output({
    summary: "Whether the tool is ready",
    fields: [{ path: "data.ready", summary: "True when ready" }],
    parse(value: unknown) {
      if (typeof value !== "object" || value === null || !("ready" in value) || typeof value.ready !== "boolean") {
        throw new TypeError("Expected a readiness result");
      }
      return { ready: value.ready };
    },
  }),
  run: () => completed({ ready: true }),
  human: (value) => value.ready ? "Ready" : "Not ready",
});
```

일반 실행의 성공 결과는 stdout에 JSON 하나로 씁니다.

```json
{"status":"completed","data":{"ready":true}}
```

`--human`은 선언한 렌더러를 사용하며 없으면 읽기 좋은 JSON을 출력합니다. 실행하는 핸들러는 같습니다. 두 모드 모두 진단은 stderr로 보냅니다. `--human`의 일반 실패는 stderr에 `Error [CODE]: message`를 쓰고, accepted 결과에는 작업이 완료되지 않았다는 줄을 붙입니다. 일반 명령의 argv 거부와 인자 검사 중 발생한 내부 오류는 표현 플래그의 파싱이 끝나지 않았을 수 있어 `--human`이 있어도 JSON으로 보고합니다.

## 성공 데이터를 검증하고 설명하기

`output.parse`는 직접 반환한 accepted를 포함해 성공 데이터에 한 번 실행됩니다. 값을 검증하고 정규화할 수 있습니다. 파서가 없다면 출력 타입은 TypeScript 선언일 뿐입니다. 선택적 `result(data, input)` 콜백은 파싱 후 completed 결과를 `{ status: "completed" }` 또는 `{ status: "accepted" }`로 매핑할 수 있지만 데이터를 교체하지는 못합니다. 직접 반환한 accepted에는 이 매핑을 실행하지 않습니다.

성공 데이터는 표현하기 전에 일반 JSON 값으로 투영합니다. BigInt, 클래스 인스턴스, 순환 참조처럼 JSON으로 표현할 수 없는 값은 거부합니다. 객체의 undefined 속성은 생략하고 배열의 undefined 원소는 거부합니다. 사람용 렌더러는 투영한 데이터의 별도 복사본을 받아 보고할 결과를 변경하지 않습니다.

`output.fields`는 도움말에 유용한 경로를 설명하며 존재 여부를 검증하거나 파서에서 형태를 추출하지는 않습니다. 전체 결과는 `data`, 배열 항목은 `data[]`, 중첩 필드는 `data.notes[].id`로 표현합니다. `data["a.b"]`, `data[""]`, `data[" "]`처럼 인용한 키는 구두점, 빈 키, 공백을 표현합니다. 인용한 키에는 이스케이프된 제어문자도 허용합니다. 이 표기는 표시용이며 실행 가능한 쿼리 언어가 아닙니다.

`output.schema`는 `applicationSchema`로 제공하는 별도의 설명용 메타데이터입니다. 파서가 아니며 파서·필드 설명·핸들러의 일치를 증명하지 않습니다. 호출자가 의존하는 값은 그 일치를 테스트합니다.

## 채널과 종료 코드

| 종료 코드 | 의미 |
| --- | --- |
| 0 | 일반 결과의 완료 또는 접수; 페이로드가 선언한 수신 측 종료 정책 충족 및 정리 성공 |
| 1 | 애플리케이션 실패; 페이로드에서는 표현할 수 없는 레코드도 포함 |
| 2 | 잘못된 입력; 페이로드 명령의 `--human`도 포함 |
| 70 | 내부 오류, 결과 보고·정리·출력 전달 실패 |
| 130 | 인식된 중단 |

기존 실패 뒤 정리나 전달 실패가 생기면 먼저 정한 실패 분류를 유지할 수 있습니다. 페이로드의 수신 측 종료는 명령이 선언한 정책을 따릅니다. [페이로드 실패와 부분 출력](payloads.md#실패와-부분-출력)을 참고합니다.

일반 성공 결과와 페이로드 데이터는 stdout으로 갑니다. 프레임워크의 모든 실패 보고는 알 수 없는 명령과 잘못된 인자를 포함해 stderr로 갑니다. 도움말과 버전은 일반 결과 봉투가 아닌 성공한 텍스트 탐색 응답입니다.

JSON 모드의 실패 보고는 압축된 JSON 한 줄입니다. 프레임워크 진단은 `diagnostic CODE: <JSON 문자열>` 형식의 별도 물리적 한 줄이며, 문자열 안의 개행은 이스케이프합니다. 진단은 보고 앞이나 뒤에 올 수 있으므로 stderr 마지막 줄을 보고라고 가정하지 않습니다. `--human` 실패 보고는 텍스트입니다.

먼저 생산자의 종료 상태를 확인합니다. JSON 실패 상세를 수집할 때는 stdout과 stderr를 분리하고 진단 줄 외에 유효한 실패 보고가 정확히 하나인지 확인합니다. 보고가 없거나 잘못됐거나 여러 개면 0이 아닌 종료 상태를 유지하고 상세는 확인할 수 없는 것으로 취급합니다. 쓰기 실패나 강제 종료는 보고를 남기지 못할 수 있습니다. EOF나 오류 객체의 부재로 성공을 판단하지 않습니다.

이 프레이밍은 프레임워크가 두 스트림을 소유한다는 전제입니다. 핸들러는 프로세스 스트림에 직접 쓰기보다 데이터를 반환하고, 별도로 정한 진단 목적지에 `onDiagnostic`을 연결합니다. 임의의 애플리케이션·라이브러리 출력은 보고를 흉내 낼 수 있으며 이 프레이밍은 이를 인증하지 않습니다. stderr를 stdout에 합쳐도 채널 구분은 사라집니다.

## 보고 실패와 롤백 구분하기

핸들러가 성공을 반환했지만 출력 파싱·상태 매핑·직렬화·렌더링이 실패하면 `RESULT_NOT_REPORTED`가 알려진 반환 상태를 보존합니다. `CONTEXT_CLEANUP_FAILED`도 성공한 핸들러의 상태를 보존할 수 있습니다. 핸들러 예외만으로 외부 상태가 바뀌었는지 알 수는 없습니다. 재시도 전에 상태를 확인합니다. 출력 오류나 중단은 수행한 작업을 되돌리지 않습니다.

`Fault`는 `code`, `message`, 선택적 일반 JSON `details`를 공개합니다. 내부 원인은 명시적인 `onDiagnostic` 콜백으로만 받을 수 있으며 기본 동작은 스택이나 서비스 응답 원문을 출력하지 않습니다. 정리·취소·프로세스 출력 소유권은 [실행](execution.md)을 참고합니다.
