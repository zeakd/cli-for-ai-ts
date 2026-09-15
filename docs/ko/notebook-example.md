# 노트 예제 살펴보기

[English](../notebook-example.md) · 한국어 · [README](../../README.ko.md)

명령은 허용하는 입력을 선언하고 실행 결과를 반환합니다. 애플리케이션은 명령을 호출 경로에 배치하고, Node 진입점은 이를 argv, stdin, 프로세스 출력에 연결합니다. 이 부분들을 분리하면 같은 명령을 테스트에서는 메모리 저장소로, 실행 파일에서는 파일 저장소로 실행할 수 있습니다.

로컬 예제는 노트를 관리하는 CLI입니다. 노트 명령은 하나의 그룹 아래에 있고, 상태를 확인하는 명령은 루트에 있습니다. 명령 정의에는 호출 경로가 들어 있지 않습니다. `app.ts`에서 각 명령을 어디에 배치할지 정합니다.

```text
notebook
├── status
├── note
│   ├── add
│   ├── list
│   ├── show
│   ├── remove
│   ├── import
│   ├── export
│   └── texts
└── config
    ├── get
    └── set
```

## 예제 살펴보기

예제 소스를 실행하기 전에 패키지를 빌드합니다. 예제는 설치된 패키지를 사용하는 프로젝트와 마찬가지로, 워크스페이스 의존성을 통해 컴파일된 배포물을 가져옵니다. Node 24 이상을 사용합니다.

```sh
pnpm install --frozen-lockfile
pnpm build
node examples/local-cli/src/cli.ts
node examples/local-cli/src/cli.ts note
node examples/local-cli/src/cli.ts note add --help
```

인자 없는 호출과 `--help`는 같은 최상위 도움말을 보여줍니다. `note` 그룹은 저장소를 변경하지 않고 하위 명령을 보여줍니다. 실행 명령은 입력 계약이 허용하면 인자 없이도 실행할 수 있습니다. 반면 `note add`는 노트 내용이 빠졌다는 오류를 반환합니다. 탐색 과정에서는 저장소 컨텍스트를 생성하지 않습니다.

## 격리된 저장소 사용하기

저장 디렉터리는 실행 파일에서 선택합니다. NOTEBOOK_HOME을 빈 디렉터리로 지정하면 평소 사용하는 노트와 분리해 예제를 실행할 수 있습니다. 이는 노트 예제의 관례이며, 프레임워크가 모든 애플리케이션에 홈 디렉터리를 요구하는 것은 아닙니다.

```sh
export NOTEBOOK_HOME="$(mktemp -d)"
node examples/local-cli/src/cli.ts note add "Buy milk" --tag home
node examples/local-cli/src/cli.ts note list
node examples/local-cli/src/cli.ts note list --human
```

일반 결과는 stdout이 터미널이든 파이프든 JSON으로 출력합니다. `--human`은 명령의 렌더러를 선택하고, 렌더러가 없으면 읽기 좋게 정렬한 JSON을 보여줍니다. 읽거나 쓰는 노트는 달라지지 않습니다. 목록 결과에는 반환한 개수와 전체 일치 개수가 함께 들어 있어, 호출자가 이번에 받은 항목과 조건에 맞는 전체 항목을 구분할 수 있습니다.

## 결과 설명 읽기

`note list --help`는 입력 옵션과 함께 결과 필드를 설명합니다. 예를 들어 `data.notes[].id`는 `note show`와 `note remove`에 전달하는 식별자이며, `data.returned`와 `data.total`은 일치하는 전체 항목 중 얼마나 반환했는지 알려줍니다. 이 경로는 JSON 출력을 설명합니다. `--human`은 다른 표현을 사용할 수 있습니다.

설명은 명령 선언의 `output.fields`에서 가져옵니다. 핸들러의 결과와 출력 파서에 맞게 관리해야 하며, 프레임워크가 설명한 필드의 실제 존재 여부를 검사하지는 않습니다. 공통 결과 상태와 종료 코드는 명령 없이 도구를 호출하거나 `--help`로 읽는 루트 도움말에서 설명합니다.

## 데이터를 직접 내보내기

`note export`는 노트 객체를 JSONL로, `note texts`는 노트 내용을 LF로 구분해 출력합니다. `note texts --null`은 개행이 들어 있는 내용을 구분할 수 있도록 NUL을 사용합니다.

```sh
node examples/local-cli/src/cli.ts note export --help
node examples/local-cli/src/cli.ts note export --tag home
node examples/local-cli/src/cli.ts note texts --null
```

이 명령들은 결과 봉투 없이 페이로드를 출력하고 오류를 stderr로 보냅니다. 실패하면 앞서 출력한 데이터는 남을 수 있습니다. 노트 저장소는 여전히 JSON 문서 전체를 읽으므로, 이 예제는 출력 계약을 보여주며 저장소가 데이터를 한 건씩 읽는 것은 아닙니다. [페이로드 내보내기](payloads.md)에서 지연 소스와 완료 확인을 설명합니다.

## 설정 적용과 일괄 가져오기

노트의 `default-tag`는 `note add`에 `--tag`를 명시하지 않았을 때 적용됩니다. 태그를 명시하면 그 값이 우선합니다. 이 우선순위는 노트 애플리케이션의 동작이며, 프레임워크 전체에 적용되는 규칙이 아닙니다.

```sh
node examples/local-cli/src/cli.ts config set default-tag work
node examples/local-cli/src/cli.ts note add "Review the release"
node examples/local-cli/src/cli.ts note add "Book a table" --tag personal
printf '%s\n' '[{"text":"Read the proposal","tags":["work"]}]' | node examples/local-cli/src/cli.ts note import
```

가져오기는 저장소 컨텍스트를 만들기 전에 모든 항목을 검사합니다. JSON 값, 노트 형태, 태그가 유효하지 않으면 종료 코드 2를 반환하고 아무것도 쓰지 않습니다. 유효한 묶음은 한 번의 문서 갱신으로 저장합니다. 파일시스템 쓰기 자체가 실패하지 않는다는 보장은 아닙니다.

`note import --help`로 입력 설명을 살펴볼 수 있습니다. [입력과 제약](inputs.md)에서는 설명, 검사 함수, stdin 형태 파서를 함께 선언하는 방법을 다룹니다.

## 의존성을 명시적으로 전달하기

예제의 컨텍스트는 노트 저장소와 설정 저장소를 제공합니다. 구현은 문서 저장소와 시계를 전달받으며, 테스트에서는 메모리 문서 저장소와 고정된 시계를 제공합니다. 명령의 배치나 출력 방식이 저장소 구현을 결정하지 않습니다.

컨텍스트는 부수효과가 있는 코드를 교체할 수 있게 하지만, 그 코드를 순수하게 만들지는 않습니다. 값만 검사하는 규칙은 일반 함수로 작성하고, 문서 읽기와 변경 저장은 이를 둘러싼 실행 코드에서 처리할 수 있습니다.

## 핸들러 형태 선택하기

코어는 자체 결과 값을 동기적으로 받거나 Promise로 받습니다. neverthrow를 사용하는 서비스는 해당 핸들러에서 `fromNeverthrow`로 연결할 수 있습니다. 루트 모듈을 가져온다고 해서 다른 명령의 어댑터까지 선택되지는 않습니다.

호환되는 타입의 실패 값은 어댑터를 그대로 통과할 수 있습니다. 도메인 오류의 형태가 다르면 오류 변환 함수를 제공합니다. 이 변환은 호출자에게 실패를 설명하기 위한 것이며, 예상하지 못한 예외는 내부 오류로 남습니다.

## 두 경계에서 검증하기

메모리 기반 테스트는 파일을 쓰지 않고 명령의 동작을 확인합니다. 실제 프로세스 테스트는 격리된 디렉터리에서 인자 라우팅, 출력 채널, 종료 상태, 데이터 보존을 확인합니다. 두 방식은 각각 다른 경계를 확인하는 데 유용합니다. 핸들러가 올바르게 동작한다고 해서 실행 파일이 입력을 올바르게 연결하거나 종료 전에 출력을 모두 내보낸다고 보장할 수는 없습니다.

```sh
pnpm typecheck
pnpm test
```

[명령](commands.md), [실행](execution.md), [어댑터](adapters.md), [테스트](testing.md)에서 해당 선언과 경계를 이어서 살펴볼 수 있습니다.
