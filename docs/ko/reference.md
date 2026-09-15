# API 참조

[English](../reference.md) · 한국어 · [README](../../README.ko.md)

공개 API의 위치와 기본값을 정리합니다. 사용법은 주제별 문서에서 설명하며, 연결된 소스 선언에 전체 제네릭 시그니처와 타입이 있습니다.

## 패키지 진입점

| Import | exports와 목적 |
| --- | --- |
| `cli-for-ai` | 선언, 결과, 탐색, 프로세스 없는 실행; [루트 exports](../../src/index.ts) |
| `cli-for-ai/node` | `run`, `Host`, `RunOptions`; [Node runner](../../src/node/index.ts) |
| `cli-for-ai/neverthrow` | `fromNeverthrow`와 소스·옵션 타입; [어댑터](../../src/adapters/neverthrow.ts) |
| `cli-for-ai/effect` | `fromEffect`, 소스·옵션 타입, `EffectCauseError`; [어댑터](../../src/adapters/effect.ts) |
| `cli-for-ai/lint` | `lintSchema`, `lintSummary`, 스키마·finding 타입; [lint](../../src/lint/index.ts) |
| `cli-for-ai/upgrade` | `DEV_SENTINEL`, `isNewer`, `updaterEnabled`; [업데이트 기본 함수](../../src/upgrade/index.ts) |

Upgrade 함수는 도구가 소유하는 바이너리 updater의 실행 여부를 판정하고 버전의 숫자 부분을 비교합니다. 바이너리를 내려받거나 교체하지 않으며 prerelease 접미사를 무시합니다. 완전한 SemVer 정책이나 패키지 매니저 통합이 아닙니다.

## 선언과 기본값

| 표면 | 계약 | 상세 |
| --- | --- | --- |
| `command(spec)` | 필수 summary, output, handler; 선택적 input, description, examples, constraints; 일반 명령은 result, human도 허용 | [명령](commands.md), [소스](../../src/core/command.ts) |
| `dynamicCommand(spec)` | 실행 중 정한 입력 이름; 핸들러 값은 unknown, 컨텍스트·출력 타입 유지 | [명령](commands.md#실행-중에-입력-이름-선언하기) |
| `string`, `number`, `integer`, `flag`, `positional`, `stdinText`, `stdinJson` | 리터럴을 보존하는 선택적 선언 헬퍼 | [입력](inputs.md#선언을-공유하면서-타입-보존하기) |
| `input.forward` | 첫 `--` 뒤 자식 인자를 그대로 전달; 기본값 빈 배열 | [인자 전달](inputs.md#다른-프로그램에-인자-전달하기) |
| `ConstraintFacts.provided` | 규칙의 의존 입력 중 직접 제공한 입력인지 확인 | [제약](inputs.md#기본값과-명시적-입력-구분하기) |
| `authoring<C>()` | 명령 선언의 컨텍스트 타입 연결 | [실행](execution.md) |
| `group(spec)`, `application(spec)` | 선언을 트리에 배치; 인자 없는 그룹은 도움말 | [명령](commands.md) |
| 위치 인자와 값 옵션 | 기본 타입 string; required나 default가 없으면 선택적; variadic/repeat를 선언한 경우만 배열 | [입력](inputs.md), [타입](../../src/core/input.ts) |
| 불리언 옵션 | 없으면 false, 제공하면 true; 명시적인 값 토큰 없음 | [인자 문법](inputs.md#인자-문법) |
| `check.string`, `check.number`, `constraints` | 실행 효과 전에 동기 선언 검증 | [입력](inputs.md) |
| `stdin` | 선언하면 전체 입력 읽기; 선택적 when으로 파싱된 스칼라 값의 일치 여부에 따라 선택 | [조건부 stdin](inputs.md#stdin을-읽는-조건-지정하기) |
| `output` | 일반 JSON 출력; 선택적 parse, summary, schema, fields | [결과](results.md) |
| `payload.jsonl`, `payload.text` | 객체 JSONL 또는 LF/NUL 텍스트; 기본 레코드 한도는 구분자 포함 8 MiB; `readerClose` 기본값 `"require-full"`, 선택값 `"allow"` | [페이로드](payloads.md) |
| `completed`, `accepted`, `failed` | 일반 결과; Fault는 code, message, 선택적 details | [결과](results.md) |
| `records`, `stop` | 페이로드 소스 시작 또는 생산 도중 타입이 있는 실패 보고 | [페이로드](payloads.md) |

`DEFAULT_MAX_RECORD_BYTES`는 페이로드 기본 한도를, `EXIT_CODES`는 [결과](results.md#채널과-종료-코드)에서 설명한 분류와 코드의 매핑을 제공합니다.

## 실행과 탐색

`execute(app, argv, options)`는 `Rendered`를 반환하고, `executeTo(app, argv, options)`는 주입한 sink에 쓰며 `Completion`을 반환합니다. `Rendered`는 문자열을 수집하고 `Completion`은 상태와 페이로드 진행 상황 또는 텍스트 전달 실패를 보고합니다. [실행 타입](../../src/execution/execute.ts)과 [종료 코드 표](results.md#채널과-종료-코드)를 참고합니다.

`parseInvocation(app, argv)`는 `help`, `version`, `run`, `invalid`, `internal` 중 하나를 반환합니다. argv를 파싱하지만 stdin을 읽거나 컨텍스트를 만들지 않습니다. run 호출에는 선택한 명령과 파싱된 입력이 있고, 조건부 stdin은 그 뒤 실행 단계에서 판단합니다.

`applicationSchema(app)`는 트리를 설명합니다. 명령에는 `output` 또는 `payload`가 있으므로 필드를 읽기 전에 유니온을 좁힙니다. 전역 옵션 항목에는 `all`, `ordinary-commands`, `root` 범위가 있습니다. `renderHelp(app, path, node)`는 확인된 애플리케이션·그룹·명령을 받고, `usage(app, path, node)`는 그룹·명령을 받습니다. [탐색 소스](../../src/discovery/help.ts)를 참고합니다.

정확한 옵션·타입·선언 오류는 [루트 exports](../../src/index.ts)에서 확인할 수 있습니다. 선언을 공유할 때 `as const satisfies InputDecl`로 입력 리터럴 정보를 유지합니다. 넓은 타입 주석은 컴파일 검사에 필요한 정보를 지울 수 있습니다. [공유 선언](inputs.md#stdin-선언-공유하기)을 참고합니다.
