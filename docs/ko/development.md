# 프레임워크 개발

[English](../development.md) · 한국어 · [README](../../README.ko.md)

패키지를 사용하는 애플리케이션을 만들려면 [설치 안내](getting-started.md)에서 시작합니다.
프레임워크를 수정할 때는 저장소를 복제하고 Node 24 이상과 `package.json`에 선언된 pnpm 버전을 사용합니다.

```sh
git clone https://github.com/zeakd/cli-for-ai-ts.git
cd cli-for-ai-ts
pnpm install --frozen-lockfile
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

예제는 워크스페이스 의존성으로 빌드된 패키지를 가져옵니다. 빌드 후
`node examples/local-cli/src/cli.ts --help`로 실행하고 [노트 예제](notebook-example.md)를 따라갈 수 있습니다.
테스트는 선언, 실행, 실제 프로세스, 두 예제, 설치된 패키지 소비자를 확인합니다.

패키지 관리자는 [릴리즈 workflow](releasing.md)로 발행할 수 있습니다.
