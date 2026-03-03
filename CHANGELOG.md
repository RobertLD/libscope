# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0](https://github.com/RobertLD/libscope/compare/v1.2.3...v1.3.0) (2026-03-03)


### Features

* add allowSelfSignedCerts config for corporate TLS ([#239](https://github.com/RobertLD/libscope/issues/239)) ([858ad1c](https://github.com/RobertLD/libscope/commit/858ad1ca9e55b8f31d4878433e745e470bd1be11))
* add source-type filter to search ([#246](https://github.com/RobertLD/libscope/issues/246)) ([#268](https://github.com/RobertLD/libscope/issues/268)) ([cb05ded](https://github.com/RobertLD/libscope/commit/cb05dedbdb028cd9749add0a9f5852e01cb9c2e5))
* auto-suggest tags based on content analysis ([#243](https://github.com/RobertLD/libscope/issues/243)) ([#273](https://github.com/RobertLD/libscope/issues/273)) ([da158ff](https://github.com/RobertLD/libscope/commit/da158ff5f55947a39712bd7f5ae4b0d6b421bfcd))
* bulk operations for documents ([#170](https://github.com/RobertLD/libscope/issues/170)) ([#272](https://github.com/RobertLD/libscope/issues/272)) ([7e28d2d](https://github.com/RobertLD/libscope/commit/7e28d2d03aee02059473ddac09c97fe90785abee))
* **confluence:** add --type flag for cloud vs server auth ([#241](https://github.com/RobertLD/libscope/issues/241)) ([f29029e](https://github.com/RobertLD/libscope/commit/f29029e63b201bfa446d92c7dca7901f6032b37e))
* context chunk expansion for search results ([#266](https://github.com/RobertLD/libscope/issues/266)) ([d087485](https://github.com/RobertLD/libscope/commit/d08748592d4bccf4bb726fe05f6d3ae79a97df80)), closes [#247](https://github.com/RobertLD/libscope/issues/247)
* deduplicate search results by document ([#245](https://github.com/RobertLD/libscope/issues/245)) ([#269](https://github.com/RobertLD/libscope/issues/269)) ([3dd70de](https://github.com/RobertLD/libscope/commit/3dd70ded96b12fc8808bc116f28509adefe41c53))
* document cross-references and relationship links ([#267](https://github.com/RobertLD/libscope/issues/267)) ([3151a73](https://github.com/RobertLD/libscope/commit/3151a73d1bea36106968ab5c3c99325366d8f9df)), closes [#169](https://github.com/RobertLD/libscope/issues/169)
* saved searches with filters ([#166](https://github.com/RobertLD/libscope/issues/166)) ([#271](https://github.com/RobertLD/libscope/issues/271)) ([508d82a](https://github.com/RobertLD/libscope/commit/508d82a0d20381469c251692e96ca3e26e744f1e))
* scheduled connector sync with cron expressions ([#178](https://github.com/RobertLD/libscope/issues/178)) ([#276](https://github.com/RobertLD/libscope/issues/276)) ([557cd3f](https://github.com/RobertLD/libscope/commit/557cd3f2c783a42e1711b161facbdb9ca18db9db))
* support additional document formats (PDF, Word, CSV, YAML, JSON) ([#249](https://github.com/RobertLD/libscope/issues/249)) ([#275](https://github.com/RobertLD/libscope/issues/275)) ([6c4b589](https://github.com/RobertLD/libscope/commit/6c4b58913e0733ce5a8075a0f3d1ed80233132ae))
* webhook system for document events ([#187](https://github.com/RobertLD/libscope/issues/187)) ([#274](https://github.com/RobertLD/libscope/issues/274)) ([4713d2b](https://github.com/RobertLD/libscope/commit/4713d2b20dde5dfac5d6b05dcc693b44d5fe06a7))
* wire document update to MCP, CLI, and REST API ([#182](https://github.com/RobertLD/libscope/issues/182)) ([#270](https://github.com/RobertLD/libscope/issues/270)) ([96ced04](https://github.com/RobertLD/libscope/commit/96ced04b5c4c78b47b4e74d35cc2a20628ef9fdd))
* wire up web dashboard via `libscope serve --dashboard` ([#265](https://github.com/RobertLD/libscope/issues/265)) ([cf16afd](https://github.com/RobertLD/libscope/commit/cf16afd0de285454f53fd101d6cfcda66d475c7c)), closes [#259](https://github.com/RobertLD/libscope/issues/259)


### Bug Fixes

* add input validation for search params, CLI options, and API responses ([#252](https://github.com/RobertLD/libscope/issues/252)) ([#260](https://github.com/RobertLD/libscope/issues/260)) ([d84de47](https://github.com/RobertLD/libscope/commit/d84de47ebbf1a11ed742d31d6fa428a1257a326a))
* add missing database cleanup and stream reader cancellation ([#254](https://github.com/RobertLD/libscope/issues/254)) ([#262](https://github.com/RobertLD/libscope/issues/262)) ([7a3f650](https://github.com/RobertLD/libscope/commit/7a3f650b0193ec297b5b2bafcc45c16b5007fd36))
* add request timeouts to embedding providers and RAG ([#258](https://github.com/RobertLD/libscope/issues/258)) ([e52e97f](https://github.com/RobertLD/libscope/commit/e52e97f89f6b98d6bc053a1e34f5dcd161716e0a))
* address 5 CodeQL security alerts (SSRF, TLS, ReDoS) ([#279](https://github.com/RobertLD/libscope/issues/279)) ([e2339cd](https://github.com/RobertLD/libscope/commit/e2339cd790979ad8bb03e7ffb7eb8290c493bbd3))
* address HIGH and MEDIUM audit findings ([#280](https://github.com/RobertLD/libscope/issues/280)) ([1e93987](https://github.com/RobertLD/libscope/commit/1e939879e1e15281e8e71f6abeb5e6013f1afd6f))
* apply allowSelfSignedCerts to connector fetch calls ([#240](https://github.com/RobertLD/libscope/issues/240)) ([3b7b281](https://github.com/RobertLD/libscope/commit/3b7b2813e8cb2b3798cab1232dc085e7b2766d96))
* code quality improvements from comprehensive audit ([#278](https://github.com/RobertLD/libscope/issues/278)) ([e988c63](https://github.com/RobertLD/libscope/commit/e988c63f04c497449ddfc50b55b0453c76fb9bc4))
* comprehensive audit fixes — security, performance, resilience, API hardening ([#316](https://github.com/RobertLD/libscope/issues/316)) ([5585db5](https://github.com/RobertLD/libscope/commit/5585db5ff96304cca318b6765a743a0ee85ebb04))
* **confluence:** use correct REST API paths for Server/Data Center ([#242](https://github.com/RobertLD/libscope/issues/242)) ([d1afeab](https://github.com/RobertLD/libscope/commit/d1afeabbc3c0da33de0fa756fa8748f0672b2bcb))
* connector bugs — pagination, recursion, rate limiting, auth ([#257](https://github.com/RobertLD/libscope/issues/257)) ([49fef8b](https://github.com/RobertLD/libscope/commit/49fef8b88363fbe57b4437fc38bd26675b8f1f3e))
* error handling gaps — counters, silent failures, version pruning ([#255](https://github.com/RobertLD/libscope/issues/255)) ([#264](https://github.com/RobertLD/libscope/issues/264)) ([b20cebe](https://github.com/RobertLD/libscope/commit/b20cebedf05532e3c1f83fa4984e9349400ee54f))
* **mcp:** expose relevance scores in search results ([#248](https://github.com/RobertLD/libscope/issues/248)) ([760ce21](https://github.com/RobertLD/libscope/commit/760ce213f21adc59be67453ea773800ad2fbf866))
* **mcp:** use workspace-aware database path ([#244](https://github.com/RobertLD/libscope/issues/244)) ([0ddba5a](https://github.com/RobertLD/libscope/commit/0ddba5ad5a4490f630912eed933b5e3a1acfb61e))
* move saveVersion inside transaction in updateDocument ([#256](https://github.com/RobertLD/libscope/issues/256)) ([#263](https://github.com/RobertLD/libscope/issues/263)) ([2afeae1](https://github.com/RobertLD/libscope/commit/2afeae190d1e1231f822ddd2c1f07a0b7a950b69))
* remove unsafe non-null assertions and fix type casts ([#253](https://github.com/RobertLD/libscope/issues/253)) ([#261](https://github.com/RobertLD/libscope/issues/261)) ([e549a89](https://github.com/RobertLD/libscope/commit/e549a89eb562b01cb43d4d36e4db38cda09fd4ff))
* use OS DNS resolver fallback for internal hostnames ([#237](https://github.com/RobertLD/libscope/issues/237)) ([3beb234](https://github.com/RobertLD/libscope/commit/3beb234a8365906552869a69c1a906acdd0cf993))

## [1.2.3](https://github.com/RobertLD/libscope/compare/v1.2.2...v1.2.3) (2026-03-02)

### Features

- add self-update command and fix version display ([#230](https://github.com/RobertLD/libscope/issues/230)) ([6e0a56b](https://github.com/RobertLD/libscope/commit/6e0a56b2353201909d9d782976d31e9b3452f067))

### Bug Fixes

- support indexing.allowPrivateUrls in config set command ([#234](https://github.com/RobertLD/libscope/issues/234)) ([2e74d8b](https://github.com/RobertLD/libscope/commit/2e74d8ba8837215856fcfb7ea1522eda95967894)), closes [#233](https://github.com/RobertLD/libscope/issues/233)

### Miscellaneous Chores

- bump version to 1.2.3 ([#236](https://github.com/RobertLD/libscope/issues/236)) ([3cc2ab5](https://github.com/RobertLD/libscope/commit/3cc2ab5b050cf7972a9c91d2a73da873b8858e2e))
- release 1.2.2 ([#232](https://github.com/RobertLD/libscope/issues/232)) ([c4c94a9](https://github.com/RobertLD/libscope/commit/c4c94a98fd2f9010243caacb561cf1e999783274))

## [1.2.2](https://github.com/RobertLD/libscope/compare/v1.2.2...v1.2.2) (2026-03-02)

### Features

- add self-update command and fix version display ([#230](https://github.com/RobertLD/libscope/issues/230)) ([6e0a56b](https://github.com/RobertLD/libscope/commit/6e0a56b2353201909d9d782976d31e9b3452f067))

### Miscellaneous Chores

- release 1.2.2 ([#232](https://github.com/RobertLD/libscope/issues/232)) ([c4c94a9](https://github.com/RobertLD/libscope/commit/c4c94a98fd2f9010243caacb561cf1e999783274))

## [1.2.2](https://github.com/RobertLD/libscope/compare/v1.2.1...v1.2.2) (2026-03-02)

### Bug Fixes

- resolve CodeQL alerts and add allowPrivateUrls config option ([#226](https://github.com/RobertLD/libscope/issues/226)) ([7875e37](https://github.com/RobertLD/libscope/commit/7875e371c2625abd4eabea9c6a40d8744c8a5469))

## [1.2.1](https://github.com/RobertLD/libscope/compare/v1.2.0...v1.2.1) (2026-03-02)

### Bug Fixes

- Python SDK publish — sync version from git tag and fix license ([#221](https://github.com/RobertLD/libscope/issues/221)) ([b034a54](https://github.com/RobertLD/libscope/commit/b034a548fee882c95d479699441ca62c7684da8c))

## [1.2.0](https://github.com/RobertLD/libscope/compare/v1.1.0...v1.2.0) (2026-03-02)

### Features

- add API key authentication ([#173](https://github.com/RobertLD/libscope/issues/173)) ([#208](https://github.com/RobertLD/libscope/issues/208)) ([aba755f](https://github.com/RobertLD/libscope/commit/aba755fb1828e3215b172e919f825118296da7af))
- add config validation on startup ([#172](https://github.com/RobertLD/libscope/issues/172)) ([#205](https://github.com/RobertLD/libscope/issues/205)) ([dae5759](https://github.com/RobertLD/libscope/commit/dae57597217e1902027e436d25c519a51e44d2d9))
- add confirmation prompts for destructive CLI operations ([#171](https://github.com/RobertLD/libscope/issues/171)) ([#206](https://github.com/RobertLD/libscope/issues/206)) ([a981956](https://github.com/RobertLD/libscope/commit/a981956bc9f741555b185df0a3010fe62be916b4))
- add Confluence space and page connector (closes [#153](https://github.com/RobertLD/libscope/issues/153)) ([#159](https://github.com/RobertLD/libscope/issues/159)) ([2a6a767](https://github.com/RobertLD/libscope/commit/2a6a767971befd05018e6e23bcbdbcaad34e5f82))
- add connector sync status and history tracking ([#179](https://github.com/RobertLD/libscope/issues/179)) ([#213](https://github.com/RobertLD/libscope/issues/213)) ([997a37d](https://github.com/RobertLD/libscope/commit/997a37d5431ab64b47156bd92a8d07bbe9fe224b))
- add conversational RAG search with LLM answers (closes [#119](https://github.com/RobertLD/libscope/issues/119)) ([#134](https://github.com/RobertLD/libscope/issues/134)) ([ce9c4bc](https://github.com/RobertLD/libscope/commit/ce9c4bc282ec77d15115bbedeffe7642337598ed))
- add Docker GHCR publishing workflow ([#196](https://github.com/RobertLD/libscope/issues/196)) ([#210](https://github.com/RobertLD/libscope/issues/210)) ([48687e4](https://github.com/RobertLD/libscope/commit/48687e48465b91e3218d08eac83a21a275011596))
- add Docker image and docker-compose ([#177](https://github.com/RobertLD/libscope/issues/177)) ([#192](https://github.com/RobertLD/libscope/issues/192)) ([790ab3b](https://github.com/RobertLD/libscope/commit/790ab3b759a013dd81e255ebb856eea2b40adeae))
- add document versioning and change history (closes [#120](https://github.com/RobertLD/libscope/issues/120)) ([#131](https://github.com/RobertLD/libscope/issues/131)) ([c4b0e40](https://github.com/RobertLD/libscope/commit/c4b0e4029128415b59920ed2c9a6824af9e1a945))
- add file watch mode for automatic re-indexing (closes [#114](https://github.com/RobertLD/libscope/issues/114)) ([#124](https://github.com/RobertLD/libscope/issues/124)) ([43d1bf4](https://github.com/RobertLD/libscope/commit/43d1bf4ff25fbbb449c1b95de9e3a406793f4687))
- add GitHub/GitLab repository doc indexing (closes [#118](https://github.com/RobertLD/libscope/issues/118)) ([#125](https://github.com/RobertLD/libscope/issues/125)) ([e7a5dbc](https://github.com/RobertLD/libscope/commit/e7a5dbcbeffb9ad91dea8727d2a7020b522aa01e))
- add Go SDK for REST API (closes [#149](https://github.com/RobertLD/libscope/issues/149)) ([#160](https://github.com/RobertLD/libscope/issues/160)) ([d9b5e4e](https://github.com/RobertLD/libscope/commit/d9b5e4ecfd2de0171ff7343d2a0244c956dde15d))
- add incremental re-embedding for model migration (closes [#123](https://github.com/RobertLD/libscope/issues/123)) ([#136](https://github.com/RobertLD/libscope/issues/136)) ([6664131](https://github.com/RobertLD/libscope/commit/666413197422502a4451564b3009ef162263c626))
- add knowledge graph visualization to web dashboard (closes [#142](https://github.com/RobertLD/libscope/issues/142)) ([#144](https://github.com/RobertLD/libscope/issues/144)) ([9a0801e](https://github.com/RobertLD/libscope/commit/9a0801ea4fcb22adb27821d9d6625ef5c8a7f2c0))
- add knowledge pack system for installable doc bundles (closes [#137](https://github.com/RobertLD/libscope/issues/137)) ([#145](https://github.com/RobertLD/libscope/issues/145)) ([0024170](https://github.com/RobertLD/libscope/commit/0024170fbca4630e8c28314854e9a37b24e9039f))
- add local web UI dashboard (closes [#117](https://github.com/RobertLD/libscope/issues/117)) ([#130](https://github.com/RobertLD/libscope/issues/130)) ([36e58c3](https://github.com/RobertLD/libscope/commit/36e58c35c42d998e71257fa18de2c93394fa38e2))
- add multi-database workspace support (closes [#115](https://github.com/RobertLD/libscope/issues/115)) ([#132](https://github.com/RobertLD/libscope/issues/132)) ([3a343b7](https://github.com/RobertLD/libscope/commit/3a343b76138edcae3b353081e083dac9e0b3cbd1))
- add multi-label tag system for document organization (closes [#121](https://github.com/RobertLD/libscope/issues/121)) ([#128](https://github.com/RobertLD/libscope/issues/128)) ([e0a6015](https://github.com/RobertLD/libscope/commit/e0a6015425b84886953028cf6d4423f9ab7aa3fc))
- add Notion page and database connector (closes [#152](https://github.com/RobertLD/libscope/issues/152)) ([#156](https://github.com/RobertLD/libscope/issues/156)) ([08a7437](https://github.com/RobertLD/libscope/commit/08a7437b25bd01cc099e3a2b9bb626010920959f))
- add Obsidian vault connector with incremental sync (closes [#146](https://github.com/RobertLD/libscope/issues/146)) ([#155](https://github.com/RobertLD/libscope/issues/155)) ([24c3037](https://github.com/RobertLD/libscope/commit/24c3037edaf6d7f995af2e57345918134c228ec1))
- add offset parameter to REST API search endpoint ([#174](https://github.com/RobertLD/libscope/issues/174)) ([#204](https://github.com/RobertLD/libscope/issues/204)) ([6dc2df4](https://github.com/RobertLD/libscope/commit/6dc2df44e898b8e38e4c6a0c17723b9fe07e63bb))
- add OneNote connector via Microsoft Graph API (closes [#147](https://github.com/RobertLD/libscope/issues/147)) ([#154](https://github.com/RobertLD/libscope/issues/154)) ([f549a2e](https://github.com/RobertLD/libscope/commit/f549a2e9038f2ce69d2c4111908046834fb42243))
- add Python SDK for REST API (closes [#148](https://github.com/RobertLD/libscope/issues/148)) ([#161](https://github.com/RobertLD/libscope/issues/161)) ([70fe5db](https://github.com/RobertLD/libscope/commit/70fe5db03274511d7484391c9fd80d031f83d41a))
- add REST API server with OpenAPI spec (closes [#150](https://github.com/RobertLD/libscope/issues/150)) ([#157](https://github.com/RobertLD/libscope/issues/157)) ([a9ae913](https://github.com/RobertLD/libscope/commit/a9ae913fa46c71fa34fa0af6d2e039002e428303))
- add Server-Sent Events streaming for RAG responses ([#175](https://github.com/RobertLD/libscope/issues/175)) ([#211](https://github.com/RobertLD/libscope/issues/211)) ([d6264bf](https://github.com/RobertLD/libscope/commit/d6264bfd97081b61bc1ea982271b8ab6576ce34e))
- add similarity-based deduplication on ingest (closes [#116](https://github.com/RobertLD/libscope/issues/116)) ([#126](https://github.com/RobertLD/libscope/issues/126)) ([3a8f829](https://github.com/RobertLD/libscope/commit/3a8f8292e02c5420cde46ebe9d58b796055e06a6))
- add Slack channel connector with thread aggregation (closes [#151](https://github.com/RobertLD/libscope/issues/151)) ([#158](https://github.com/RobertLD/libscope/issues/158)) ([97f706f](https://github.com/RobertLD/libscope/commit/97f706f8ec96538fb772b5bf5b664e98e3b8971a))
- add usage analytics and content health metrics (closes [#122](https://github.com/RobertLD/libscope/issues/122)) ([#133](https://github.com/RobertLD/libscope/issues/133)) ([6b25ab1](https://github.com/RobertLD/libscope/commit/6b25ab18932050056eab09121364c356167ab3df))
- prepare Python SDK for PyPI publishing as pylibscope ([#189](https://github.com/RobertLD/libscope/issues/189)) ([4ff0d5c](https://github.com/RobertLD/libscope/commit/4ff0d5cbe381331b272f0561acf53b173dc40ff2)), closes [#183](https://github.com/RobertLD/libscope/issues/183)
- search analytics dashboard with knowledge gap detection ([#167](https://github.com/RobertLD/libscope/issues/167)) ([#212](https://github.com/RobertLD/libscope/issues/212)) ([5580d89](https://github.com/RobertLD/libscope/commit/5580d8986063860b50b268aa81e3b28ee888cde7))

### Bug Fixes

- add retry logic for Notion/Slack/Confluence connectors ([#176](https://github.com/RobertLD/libscope/issues/176)) ([#207](https://github.com/RobertLD/libscope/issues/207)) ([05e11c3](https://github.com/RobertLD/libscope/commit/05e11c39ee4d714fee32b113e666b147109f6537))
- add vercel.json to install devDependencies for vitepress build ([#214](https://github.com/RobertLD/libscope/issues/214)) ([3324461](https://github.com/RobertLD/libscope/commit/3324461c96813f91550d772de9f7414058d7adf4))
- cap rate limiter memory with sliding window counter ([#180](https://github.com/RobertLD/libscope/issues/180)) ([#193](https://github.com/RobertLD/libscope/issues/193)) ([28dba0b](https://github.com/RobertLD/libscope/commit/28dba0b0335a59e3c1ef42114d41ad4475f78727))
- deduplicate streaming chunker overlap ([#186](https://github.com/RobertLD/libscope/issues/186)) ([#194](https://github.com/RobertLD/libscope/issues/194)) ([0355009](https://github.com/RobertLD/libscope/commit/0355009bc34135f9a3f47f8caa4c8c36dba30222))
- Docker build failing due to husky in prepare script ([#219](https://github.com/RobertLD/libscope/issues/219)) ([76d6812](https://github.com/RobertLD/libscope/commit/76d68120719a04831646613bd229ebb2f34069fe))
- OneNote rate limiter race condition and CLI lint warnings ([#164](https://github.com/RobertLD/libscope/issues/164)) ([a018cf8](https://github.com/RobertLD/libscope/commit/a018cf8fddaf6959b3a48f31bd82cfdaef8db4b6))
- pass dbPath to getStats for accurate databaseSizeBytes ([#185](https://github.com/RobertLD/libscope/issues/185)) ([#195](https://github.com/RobertLD/libscope/issues/195)) ([0579d14](https://github.com/RobertLD/libscope/commit/0579d1433c5ddb112a07736a193bb52c8cdff1f1))
- resolve CodeQL alerts, update license to BSL 1.1, fix README badges ([#218](https://github.com/RobertLD/libscope/issues/218)) ([3d28d7e](https://github.com/RobertLD/libscope/commit/3d28d7eb1ed6d564c880cb9bd12733de9b421ced))
- **security:** override esbuild to &gt;=0.25.0 to resolve CVE ([#216](https://github.com/RobertLD/libscope/issues/216)) ([7d5a130](https://github.com/RobertLD/libscope/commit/7d5a1306ac8c2e38fd9dbc0f9e9039477bcd4303))
- update engines to node &gt;=20 ([#217](https://github.com/RobertLD/libscope/issues/217)) ([4419a38](https://github.com/RobertLD/libscope/commit/4419a38f160fd39ee896fb458bf9b614070c5d71))
- validate parseInt results in API routes and fix watcher memory leak ([#163](https://github.com/RobertLD/libscope/issues/163)) ([7712dee](https://github.com/RobertLD/libscope/commit/7712deefcd7944d267e3aeebd9cd98ea5c74cadb))

## [1.1.0](https://github.com/RobertLD/libscope/compare/v1.0.1...v1.1.0) (2026-03-01)

### Features

- add batch import with parallel processing (closes [#46](https://github.com/RobertLD/libscope/issues/46)) ([#70](https://github.com/RobertLD/libscope/issues/70)) ([81fb08a](https://github.com/RobertLD/libscope/commit/81fb08a3db696d06b32370b27ffe4edeec94c804))
- add date range and source filters to search (closes [#94](https://github.com/RobertLD/libscope/issues/94)) ([#113](https://github.com/RobertLD/libscope/issues/113)) ([84e1df0](https://github.com/RobertLD/libscope/commit/84e1df0dec73b7bb3b10c64f54cb20c70b4358c0))
- add delete-document and management MCP tools (closes [#88](https://github.com/RobertLD/libscope/issues/88), closes [#93](https://github.com/RobertLD/libscope/issues/93)) ([#107](https://github.com/RobertLD/libscope/issues/107)) ([7254725](https://github.com/RobertLD/libscope/commit/7254725e7479619f389b05494facf17c7de3a0f1))
- add document update/edit capability ([#108](https://github.com/RobertLD/libscope/issues/108)) ([85dbafb](https://github.com/RobertLD/libscope/commit/85dbafb4a5460dfdb4309be64b51b8723a0b7a1e))
- add document versioning and update detection (closes [#47](https://github.com/RobertLD/libscope/issues/47)) ([#67](https://github.com/RobertLD/libscope/issues/67)) ([31dcb85](https://github.com/RobertLD/libscope/commit/31dcb852ff49239f24d109adea56ae205473c6f5))
- add export/backup functionality (closes [#48](https://github.com/RobertLD/libscope/issues/48)) ([#69](https://github.com/RobertLD/libscope/issues/69)) ([902cfba](https://github.com/RobertLD/libscope/commit/902cfba74fef07a9973efe5e6e1de3a425a09181))
- add health-check MCP tool ([#63](https://github.com/RobertLD/libscope/issues/63)) ([e863254](https://github.com/RobertLD/libscope/commit/e8632540013d1d4b967a257eb9c8c184199bd9c4)), closes [#45](https://github.com/RobertLD/libscope/issues/45)
- add interactive search REPL mode to CLI (closes [#95](https://github.com/RobertLD/libscope/issues/95)) ([#112](https://github.com/RobertLD/libscope/issues/112)) ([2e1d2c7](https://github.com/RobertLD/libscope/commit/2e1d2c741d83935d5d6d8bdd519ab14ab6cf4e6f))
- add plugin interface for custom embedding providers (closes [#96](https://github.com/RobertLD/libscope/issues/96)) ([#110](https://github.com/RobertLD/libscope/issues/110)) ([5ce49ac](https://github.com/RobertLD/libscope/commit/5ce49ac5a6cf1c51ac28aabaee76a0a697a1ddf0))
- add retry logic with exponential backoff for embedding providers ([#66](https://github.com/RobertLD/libscope/issues/66)) ([2843571](https://github.com/RobertLD/libscope/commit/284357196ac45e226e3bdb1ead314186f4d0a86c)), closes [#42](https://github.com/RobertLD/libscope/issues/42)
- add search result pagination (closes [#49](https://github.com/RobertLD/libscope/issues/49)) ([#68](https://github.com/RobertLD/libscope/issues/68)) ([0b28fcf](https://github.com/RobertLD/libscope/commit/0b28fcf0a66277230a01cc50b23bdd9ca1e3cadc))
- add search result scoring explanation (closes [#89](https://github.com/RobertLD/libscope/issues/89)) ([#111](https://github.com/RobertLD/libscope/issues/111)) ([60140f5](https://github.com/RobertLD/libscope/commit/60140f5453bc74cb36f332f8bf90b6d41be0fcca))
- add streaming support for large document ingestion (closes [#43](https://github.com/RobertLD/libscope/issues/43)) ([#72](https://github.com/RobertLD/libscope/issues/72)) ([a907766](https://github.com/RobertLD/libscope/commit/a90776689211617614a8bf5900b1c828896122be))
- add structured logging throughout the application (closes [#44](https://github.com/RobertLD/libscope/issues/44)) ([#71](https://github.com/RobertLD/libscope/issues/71)) ([83a99a1](https://github.com/RobertLD/libscope/commit/83a99a1dd2443d1234fa82a1217d5b8f5a8b4f01))
- add topic deletion, rename, and browsing (closes [#90](https://github.com/RobertLD/libscope/issues/90)) ([#109](https://github.com/RobertLD/libscope/issues/109)) ([6ce28b2](https://github.com/RobertLD/libscope/commit/6ce28b2bb382796be795fbcddca9037fff6206a6))
- configurable URL fetcher timeout and limits (closes [#92](https://github.com/RobertLD/libscope/issues/92)) ([#104](https://github.com/RobertLD/libscope/issues/104)) ([67b9619](https://github.com/RobertLD/libscope/commit/67b96196d9e97330d54327f804f404ce3304931f))

### Bug Fixes

- add foreign key validation in topics and ratings ([#57](https://github.com/RobertLD/libscope/issues/57)) ([8826492](https://github.com/RobertLD/libscope/commit/8826492753bdb5ccd5a0be7e1cd86a88eff2ec63)), closes [#37](https://github.com/RobertLD/libscope/issues/37)
- add input and response validation to embedding providers ([#59](https://github.com/RobertLD/libscope/issues/59)) ([3d8e832](https://github.com/RobertLD/libscope/commit/3d8e832c6bc3d5b93e9b1da2ad7f599c74f349e6)), closes [#34](https://github.com/RobertLD/libscope/issues/34)
- add jitter to retry backoff and handle maxRetries=0 edge case (closes [#75](https://github.com/RobertLD/libscope/issues/75)) ([#97](https://github.com/RobertLD/libscope/issues/97)) ([2316ecd](https://github.com/RobertLD/libscope/commit/2316ecdfb75280396de54a4d3c0dac73d3cd08f4))
- add logging to silent catch blocks ([#60](https://github.com/RobertLD/libscope/issues/60)) ([b8932c3](https://github.com/RobertLD/libscope/commit/b8932c39ceb36fa027c7fb93c50c227e8a3c732a)), closes [#38](https://github.com/RobertLD/libscope/issues/38)
- add SSRF protection and streaming body size limit (closes [#78](https://github.com/RobertLD/libscope/issues/78), closes [#80](https://github.com/RobertLD/libscope/issues/80)) ([#103](https://github.com/RobertLD/libscope/issues/103)) ([3bb898b](https://github.com/RobertLD/libscope/commit/3bb898b3dfdc4601c128465a3d8f39c5d89d8aec))
- clamp search scores and add minRating filter to all search strategies ([#55](https://github.com/RobertLD/libscope/issues/55)) ([57ff2e6](https://github.com/RobertLD/libscope/commit/57ff2e619474e1c014cdfd2a9e5eec1b6fb0c0f1)), closes [#28](https://github.com/RobertLD/libscope/issues/28)
- extract shared initializeApp() helper in CLI ([#62](https://github.com/RobertLD/libscope/issues/62)) ([1e83720](https://github.com/RobertLD/libscope/commit/1e83720086afdeca5bd6043b3d0c8fccfd3b8bc6)), closes [#33](https://github.com/RobertLD/libscope/issues/33)
- extract shared test utilities to fixtures directory ([#64](https://github.com/RobertLD/libscope/issues/64)) ([041a638](https://github.com/RobertLD/libscope/commit/041a638776a968240972818b6489389642434431)), closes [#41](https://github.com/RobertLD/libscope/issues/41)
- improve database connection lifecycle management ([#53](https://github.com/RobertLD/libscope/issues/53)) ([fd653e8](https://github.com/RobertLD/libscope/commit/fd653e8103e90b146ee95a3b0fdb968f946a52a7)), closes [#36](https://github.com/RobertLD/libscope/issues/36)
- include content_hash in export/import (closes [#76](https://github.com/RobertLD/libscope/issues/76)) ([#100](https://github.com/RobertLD/libscope/issues/100)) ([becb535](https://github.com/RobertLD/libscope/commit/becb535cfce07b3630931f0b6abeb5e774761e8e))
- move MCP server initialization into main() with error handling ([#61](https://github.com/RobertLD/libscope/issues/61)) ([c0e4da8](https://github.com/RobertLD/libscope/commit/c0e4da8150e6ea2452d567f76b99a919cc6bbe41)), closes [#32](https://github.com/RobertLD/libscope/issues/32)
- prevent error double-wrapping in embedding providers ([#56](https://github.com/RobertLD/libscope/issues/56)) ([ca7dab9](https://github.com/RobertLD/libscope/commit/ca7dab95fbb7f341c880a386b6c7c9276f4604a0)), closes [#30](https://github.com/RobertLD/libscope/issues/30)
- proper count queries and safer DB type handling (closes [#81](https://github.com/RobertLD/libscope/issues/81), closes [#82](https://github.com/RobertLD/libscope/issues/82)) ([#105](https://github.com/RobertLD/libscope/issues/105)) ([06f96aa](https://github.com/RobertLD/libscope/commit/06f96aabd83f0400d6902b092b3db5bf5beb60ca))
- provider validation, Ollama response check, test DRY, .env.example (closes [#84](https://github.com/RobertLD/libscope/issues/84), closes [#85](https://github.com/RobertLD/libscope/issues/85), closes [#86](https://github.com/RobertLD/libscope/issues/86), closes [#91](https://github.com/RobertLD/libscope/issues/91)) ([#98](https://github.com/RobertLD/libscope/issues/98)) ([ab39e9d](https://github.com/RobertLD/libscope/commit/ab39e9d1113793c41dd654db1bb1852fdac4e8c3))
- remove unused deepMerge function from config.ts ([#52](https://github.com/RobertLD/libscope/issues/52)) ([c672859](https://github.com/RobertLD/libscope/commit/c6728591c1cb9af2d4f99bb4cfe3441902ce0d0d)), closes [#39](https://github.com/RobertLD/libscope/issues/39)
- replace N+1 rating subqueries with JOIN aggregation in search ([#58](https://github.com/RobertLD/libscope/issues/58)) ([5b297f5](https://github.com/RobertLD/libscope/commit/5b297f5bbc201ceabd7fa7534e86988b196988ac)), closes [#29](https://github.com/RobertLD/libscope/issues/29)
- replace unsafe non-null assertions in indexing.ts ([#51](https://github.com/RobertLD/libscope/issues/51)) ([ea03fa5](https://github.com/RobertLD/libscope/commit/ea03fa5cfafcf4c27a990c47826f4f78d9860855)), closes [#35](https://github.com/RobertLD/libscope/issues/35)
- resolve race condition in local provider initialization ([#50](https://github.com/RobertLD/libscope/issues/50)) ([94f4190](https://github.com/RobertLD/libscope/commit/94f419032e5dbc2dd614fc22d71658195537d4bc)), closes [#31](https://github.com/RobertLD/libscope/issues/31)
- standardize error handling patterns across modules ([#65](https://github.com/RobertLD/libscope/issues/65)) ([4043378](https://github.com/RobertLD/libscope/commit/4043378da3f3bc0874e95e2b204b1da4e011da72)), closes [#40](https://github.com/RobertLD/libscope/issues/40)
- targeted vector fallback errors and LIKE escaping (closes [#74](https://github.com/RobertLD/libscope/issues/74), closes [#79](https://github.com/RobertLD/libscope/issues/79)) ([#102](https://github.com/RobertLD/libscope/issues/102)) ([30151aa](https://github.com/RobertLD/libscope/commit/30151aaa56cb07c1651405f27b4dccc1774b4cbe))
- use atomic INSERT ON CONFLICT for topic creation (closes [#77](https://github.com/RobertLD/libscope/issues/77)) ([#99](https://github.com/RobertLD/libscope/issues/99)) ([5430f7b](https://github.com/RobertLD/libscope/commit/5430f7b785b5b24b35c697dde2227f3a22729f28))
- wrap CLI handlers in try-finally for DB cleanup (closes [#73](https://github.com/RobertLD/libscope/issues/73)) ([#106](https://github.com/RobertLD/libscope/issues/106)) ([7869854](https://github.com/RobertLD/libscope/commit/786985489e768b4b281c629ee5dbb629487adcdd))

### Performance Improvements

- optimize chunk size calculation from O(n²) to O(n) (closes [#83](https://github.com/RobertLD/libscope/issues/83)) ([#101](https://github.com/RobertLD/libscope/issues/101)) ([e05a524](https://github.com/RobertLD/libscope/commit/e05a52465c5272f61ef323cf13fdc07710325d80))

## [1.0.1](https://github.com/RobertLD/libscope/compare/v1.0.0...v1.0.1) (2026-03-01)

### Bug Fixes

- add id-token permission for npm provenance publishing ([#26](https://github.com/RobertLD/libscope/issues/26)) ([a5d46cd](https://github.com/RobertLD/libscope/commit/a5d46cdace210f2f5526426f9bbac73c109f9a1d))

## 1.0.0 (2026-03-01)

### ⚠ BREAKING CHANGES

- resolve all 23 open issues

### Features

- add agents.md, FTS5 search, URL ingestion, bulk import ([62f5f8e](https://github.com/RobertLD/libscope/commit/62f5f8eddc3b0b0e643d68201830329c104d0b73))
- initial LibScope project scaffold ([ac88a09](https://github.com/RobertLD/libscope/commit/ac88a097adef8ec544880bd020df6e96fcd55a51))
- MCP submit-document now accepts URL for auto-fetch ([a103c66](https://github.com/RobertLD/libscope/commit/a103c6648c689a841d09105f0bbfd5f28e56a3a8))

### Bug Fixes

- lower coverage thresholds to 75% for CI platform variance ([bd0fca6](https://github.com/RobertLD/libscope/commit/bd0fca68b56ca4b389a8c95f1edf30d09f085d07))
- remove Node 18 from CI matrix (vitest 4.x requires Node 20+) ([7ff42c2](https://github.com/RobertLD/libscope/commit/7ff42c2108a834cac190f956ef8b899c848df37d))
- resolve all 23 open issues ([926dc80](https://github.com/RobertLD/libscope/commit/926dc80813d0302970ea8a01f28503d19b1c0c90)), closes [#15](https://github.com/RobertLD/libscope/issues/15)

## [0.1.0] - 2026-02-28

### Added

- **MCP Server** with 5 tools: `search-docs`, `get-document`, `rate-document`, `submit-document`, `list-topics`
- **CLI** with commands: `init`, `add`, `search`, `topics`, `ratings`, `serve`, `config`
- **Embedding providers**: local (all-MiniLM-L6-v2), Ollama, OpenAI — configurable via CLI or env vars
- **SQLite + sqlite-vec** storage with vector similarity search and keyword fallback
- **Ratings system** — rate documents 1-5, provide feedback, suggest corrections
- **Topic hierarchy** — organize docs by topic with parent/child relationships
- **Document types** — library docs (versioned), topic docs, manual, and model-generated
- **Strict TypeScript** config with full type safety
- **GitHub Actions CI/CD** — lint, typecheck, test (Node 18/20/22 matrix), build, npm publish, CodeQL
- **65 tests** — unit and integration test suite with Vitest
