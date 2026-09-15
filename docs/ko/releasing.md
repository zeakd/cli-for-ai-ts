# npm 배포하기

[English](../releasing.md) · 한국어 · [개발 안내](development.md)

`Release` workflow(`release.yml`)는 `main`에서 수동 실행합니다. 정확한 패키지 버전과
`next` 또는 `latest` 태그를 지정합니다. `publish`를 끄면 발행 없이 검사와 패키지 검증만 실행합니다.

발행 전에는 코드와 문서를 검증하고, 패키지 버전과 의존성이 바뀌었다면 lockfile을 갱신한 뒤 저장소를 공개합니다. workflow는 비공개 저장소에서
제품 발행을 거부하며 provenance를 포함합니다. prerelease는 `next`를 사용합니다.

npm trusted publisher는 저장소 `zeakd/cli-for-ai-ts`, 파일 `release.yml`, 환경 `npm`으로
맞추고 직접 발행 권한을 허용합니다. GitHub-hosted runner를 사용하며 npm 토큰 secret은
필요하지 않습니다. 연결 저장만으로 OIDC 발행 성공을 증명하지는 않습니다. 실제 발행 성공으로 확인합니다.

workflow는 검사·빌드 후 한 번 패키징하고, 임시 소비자에 tarball을 설치해 실행하며,
모든 export 파일을 확인한 뒤 같은 tarball을 발행합니다. pack/publish의 `--ignore-scripts`는
검사 후 다시 빌드하는 것을 막습니다. 이미 발행한 npm 버전은 재사용할 수 없으므로 다시 발행하려면 버전을 올립니다.

[npm trusted publishing 문서](https://docs.npmjs.com/trusted-publishers/)를 참고합니다.


## 배포 권한

trusted publishing을 켜기 전에 GitHub의 `npm` 환경을 만듭니다. 선택한 배포 브랜치에
태그 패턴이 아닌 `main` 브랜치 규칙 하나를 설정합니다. 브랜치는 자기 workflow의 조건을
바꿀 수 있으므로 서버 쪽 규칙이 필요합니다. main 변경에는 저장소의 리뷰 정책을 적용합니다.
환경 제한이 main이나 환경 설정을 변경할 권한 관리까지 대신하지는 않습니다.

검증 job에는 npm 환경이나 OIDC 권한이 없습니다. 검증이 성공한 다음 발행 job만 이를
받습니다. 발행 job은 제품 의존성을 설치하거나 테스트를 실행하지 않고, 검증된 artifact를
내려받아 검증 job이 전달한 SHA-512와 비교한 뒤 발행합니다. 검사 전용 실행은 이 job을
시작하지 않습니다. 일반 CI에서도 패키징을 검사합니다. main이 아닌 수동 실행은 명세 검사에서 실패합니다.

기본 설치 대상으로 발행할 때는 `latest`, prerelease에는 `next`를 선택합니다.
