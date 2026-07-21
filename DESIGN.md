---
version: alpha
name: Personal Design System
description: 個人プロジェクト横断で使う自分用デザインシステム。各プロジェクトのルートにこのファイルをコピーして使う。
colors:
  # === Primitive（トーナルスケール。このシステムが持つ唯一の「色」）===
  # OKLCH で生成。色相ごとに H を固定し、L を全色相共通の段で刻む。
  # C は各 (L,H) で sRGB gamut に収まる範囲でタペール（中間で最大）。
  gray-50: "oklch(0.985 0.004 270)"
  gray-100: "oklch(0.965 0.004 270)"
  gray-200: "oklch(0.925 0.004 270)"
  gray-300: "oklch(0.87 0.004 270)"
  gray-400: "oklch(0.79 0.004 270)"
  gray-500: "oklch(0.68 0.004 270)"
  gray-600: "oklch(0.585 0.004 270)"
  gray-700: "oklch(0.49 0.004 270)"
  gray-800: "oklch(0.395 0.004 270)"
  gray-900: "oklch(0.3 0.004 270)"
  gray-950: "oklch(0.21 0.004 270)"
  blue-50: "oklch(0.985 0.0069 264)"
  blue-100: "oklch(0.965 0.0161 264)"
  blue-200: "oklch(0.925 0.0351 264)"
  blue-300: "oklch(0.87 0.0621 264)"
  blue-400: "oklch(0.79 0.1036 264)"
  blue-500: "oklch(0.68 0.1648 264)"
  blue-600: "oklch(0.585 0.17 264)"
  blue-700: "oklch(0.49 0.1496 264)"
  blue-800: "oklch(0.395 0.119 264)"
  blue-900: "oklch(0.3 0.0884 264)"
  blue-950: "oklch(0.21 0.0612 264)"
  green-50: "oklch(0.985 0.018 150)"
  green-100: "oklch(0.965 0.033 150)"
  green-200: "oklch(0.925 0.063 150)"
  green-300: "oklch(0.87 0.099 150)"
  green-400: "oklch(0.79 0.135 150)"
  green-500: "oklch(0.68 0.15 150)"
  green-600: "oklch(0.585 0.15 150)"
  green-700: "oklch(0.49 0.132 150)"
  green-800: "oklch(0.395 0.105 150)"
  green-900: "oklch(0.3 0.078 150)"
  green-950: "oklch(0.21 0.054 150)"
  amber-50: "oklch(0.985 0.0117 75)"
  amber-100: "oklch(0.965 0.0276 75)"
  amber-200: "oklch(0.925 0.0604 75)"
  amber-300: "oklch(0.87 0.099 75)"
  amber-400: "oklch(0.79 0.135 75)"
  amber-500: "oklch(0.68 0.1406 75)"
  amber-600: "oklch(0.585 0.1209 75)"
  amber-700: "oklch(0.49 0.1013 75)"
  amber-800: "oklch(0.395 0.0817 75)"
  amber-900: "oklch(0.3 0.062 75)"
  amber-950: "oklch(0.21 0.0434 75)"
  red-50: "oklch(0.985 0.0071 25)"
  red-100: "oklch(0.965 0.0168 25)"
  red-200: "oklch(0.925 0.0373 25)"
  red-300: "oklch(0.87 0.068 25)"
  red-400: "oklch(0.79 0.1188 25)"
  red-500: "oklch(0.68 0.19 25)"
  red-600: "oklch(0.585 0.19 25)"
  red-700: "oklch(0.49 0.1672 25)"
  red-800: "oklch(0.395 0.133 25)"
  red-900: "oklch(0.3 0.0988 25)"
  red-950: "oklch(0.21 0.0684 25)"
typography:
  h1:
    fontFamily: system-ui
    fontSize: 2.441rem
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: -0.02em
  h2:
    fontFamily: system-ui
    fontSize: 1.953rem
    fontWeight: 700
    lineHeight: 1.25
    letterSpacing: -0.01em
  h3:
    fontFamily: system-ui
    fontSize: 1.563rem
    fontWeight: 500
    lineHeight: 1.3
  body-md:
    fontFamily: system-ui
    fontSize: 1rem
    fontWeight: 400
    lineHeight: 1.6
  body-sm:
    fontFamily: system-ui
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.6
  caption:
    fontFamily: system-ui
    fontSize: 0.75rem
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: system-ui
    fontSize: 0.875rem
    fontWeight: 500
    lineHeight: 1.2
  code:
    fontFamily: ui-monospace
    fontSize: 0.875rem
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: 0.25rem
  md: 0.5rem
  lg: 0.75rem
  full: 9999px
spacing:
  xs: 0.25rem
  sm: 0.5rem
  md: 1rem
  lg: 1.5rem
  xl: 2rem
  2xl: 3rem
  3xl: 4rem
roles:
  # 役割 → スケールの薄い参照。どの色相族がその役割を担うかだけを決め、段（具体値）は決めない。
  # 役割層のトークン <役割>-color-<段>（例 danger-color-700 = red-700）はこの表から機械的に導出される。
  # 段が一意になるのは component×部位×役割が揃った点。横断 component の行は下の components で定義し、
  # プロジェクト固有 component の resolve は消費側の責務（このファイルの外）。
  primary: blue      # 主要アクション・強調
  danger: red        # 破壊的・エラー状態
  warning: amber     # 注意・警告状態
  success: green     # 成功・肯定状態
  neutral: gray      # 意味を主張しない既定。screen に限らず button-neutral 等、多数の行が参照する
components:
  # === Component（意味の完成点）===
  # トークンは component（variant があれば variant まで）を単位に完結して定義する。
  # variant 間で行を共有しない（束ねるのは、変更理由の共有が確認できた行だけ＝共有結合層の条件）。
  # 名前は <component>(-<variant>)(-<部位>)-<値種別>。
  # 色の行: 値は役割層トークン <役割>-color-<段>（roles から導出）への参照。primitive を直接参照しない。
  #         light / dark は theme modifier の分岐。名前へ焼き付けず、分岐キーとして持つ。
  #         state（hover / focus 等）も modifier。<state>-light / <state>-dark の分岐キーとして足す。
  #         例外: 文脈へ委譲する色の行は、キーワード currentColor を値に持ち、分岐を持たない
  #         （追従先の文脈が既に theme / state で分岐しているため）。
  # 非色の行（typography / rounded / spacing / shadow）: これらの値種別には役割を定義していないため、
  #         尺度のキー（md / body-sm 等）を直接参照する。theme で変わらないため分岐を持たない。
  screen-text-color:
    light: neutral-color-900
    dark: neutral-color-50
  screen-text-muted-color:
    light: neutral-color-700
    dark: neutral-color-400
  screen-background-color:
    light: neutral-color-100
    dark: neutral-color-950
  screen-surface-color:
    light: neutral-color-50
    dark: neutral-color-900
  screen-border-color:
    light: neutral-color-200
    dark: neutral-color-700
  screen-accent-color:
    light: primary-color-700
    dark: primary-color-500
  link-text-color:
    light: primary-color-700
    dark: primary-color-500
    hover-light: primary-color-800
    hover-dark: primary-color-400
    active-light: primary-color-900
    active-dark: primary-color-300
  icon-color: currentColor
  button-primary-surface-color:
    light: primary-color-700
    dark: primary-color-500
    hover-light: primary-color-800
    hover-dark: primary-color-400
    active-light: primary-color-900
    active-dark: primary-color-300
    disabled-light: primary-color-100
    disabled-dark: primary-color-900
  button-primary-text-color:
    light: neutral-color-50
    dark: neutral-color-950
    disabled-light: primary-color-400
    disabled-dark: primary-color-700
  button-primary-text-typography: label
  button-primary-rounded: md
  button-primary-padding-block-spacing: sm
  button-primary-padding-inline-spacing: lg
  button-danger-surface-color:
    light: danger-color-700
    dark: danger-color-500
    hover-light: danger-color-800
    hover-dark: danger-color-400
    active-light: danger-color-900
    active-dark: danger-color-300
    disabled-light: danger-color-100
    disabled-dark: danger-color-900
  button-danger-text-color:
    light: neutral-color-50
    dark: neutral-color-950
    disabled-light: danger-color-400
    disabled-dark: danger-color-700
  button-danger-text-typography: label
  button-danger-rounded: md
  button-danger-padding-block-spacing: sm
  button-danger-padding-inline-spacing: lg
  button-neutral-surface-color:
    light: neutral-color-200
    dark: neutral-color-800
    hover-light: neutral-color-300
    hover-dark: neutral-color-700
    active-light: neutral-color-400
    active-dark: neutral-color-900
    disabled-light: neutral-color-100
    disabled-dark: neutral-color-900
  button-neutral-text-color:
    light: neutral-color-900
    dark: neutral-color-50
    disabled-light: neutral-color-400
    disabled-dark: neutral-color-700
  button-neutral-text-typography: label
  button-neutral-rounded: md
  button-neutral-padding-block-spacing: sm
  button-neutral-padding-inline-spacing: lg
  note-success-surface-color:
    light: success-color-100
    dark: success-color-950
  note-success-border-color:
    light: success-color-300
    dark: success-color-800
  note-success-text-color:
    light: success-color-900
    dark: success-color-200
  note-success-text-typography: body-sm
  note-success-rounded: md
  note-success-padding-block-spacing: sm
  note-success-padding-inline-spacing: md
  note-warning-surface-color:
    light: warning-color-100
    dark: warning-color-950
  note-warning-border-color:
    light: warning-color-300
    dark: warning-color-800
  note-warning-text-color:
    light: warning-color-900
    dark: warning-color-200
  note-warning-text-typography: body-sm
  note-warning-rounded: md
  note-warning-padding-block-spacing: sm
  note-warning-padding-inline-spacing: md
  note-danger-surface-color:
    light: danger-color-100
    dark: danger-color-950
  note-danger-border-color:
    light: danger-color-300
    dark: danger-color-800
  note-danger-text-color:
    light: danger-color-900
    dark: danger-color-200
  note-danger-text-typography: body-sm
  note-danger-rounded: md
  note-danger-padding-block-spacing: sm
  note-danger-padding-inline-spacing: md
  note-neutral-surface-color:
    light: neutral-color-100
    dark: neutral-color-950
  note-neutral-border-color:
    light: neutral-color-300
    dark: neutral-color-800
  note-neutral-text-color:
    light: neutral-color-900
    dark: neutral-color-200
  note-neutral-text-typography: body-sm
  note-neutral-rounded: md
  note-neutral-padding-block-spacing: sm
  note-neutral-padding-inline-spacing: md
  card-surface-color:
    light: neutral-color-50
    dark: neutral-color-900
  card-border-color:
    light: neutral-color-200
    dark: neutral-color-700
  card-rounded: md
  card-padding-spacing: lg
  card-shadow: sm
  badge-success-surface-color:
    light: success-color-100
    dark: success-color-950
  badge-success-text-color:
    light: success-color-900
    dark: success-color-200
  badge-success-text-typography: caption
  badge-success-rounded: sm
  badge-success-padding-block-spacing: xs
  badge-success-padding-inline-spacing: sm
  badge-warning-surface-color:
    light: warning-color-100
    dark: warning-color-950
  badge-warning-text-color:
    light: warning-color-900
    dark: warning-color-200
  badge-warning-text-typography: caption
  badge-warning-rounded: sm
  badge-warning-padding-block-spacing: xs
  badge-warning-padding-inline-spacing: sm
  badge-danger-surface-color:
    light: danger-color-100
    dark: danger-color-950
  badge-danger-text-color:
    light: danger-color-900
    dark: danger-color-200
  badge-danger-text-typography: caption
  badge-danger-rounded: sm
  badge-danger-padding-block-spacing: xs
  badge-danger-padding-inline-spacing: sm
  badge-neutral-surface-color:
    light: neutral-color-100
    dark: neutral-color-950
  badge-neutral-text-color:
    light: neutral-color-900
    dark: neutral-color-200
  badge-neutral-text-typography: caption
  badge-neutral-rounded: sm
  badge-neutral-padding-block-spacing: xs
  badge-neutral-padding-inline-spacing: sm
  input-surface-color:
    light: neutral-color-50
    dark: neutral-color-900
    disabled-light: neutral-color-200
    disabled-dark: neutral-color-800
  input-border-color:
    light: neutral-color-300
    dark: neutral-color-700
    hover-light: neutral-color-400
    hover-dark: neutral-color-600
    disabled-light: neutral-color-200
    disabled-dark: neutral-color-800
    invalid-light: danger-color-700
    invalid-dark: danger-color-500
  input-text-color:
    light: neutral-color-900
    dark: neutral-color-50
    disabled-light: neutral-color-500
    disabled-dark: neutral-color-600
  input-placeholder-color:
    light: neutral-color-700
    dark: neutral-color-400
  input-text-typography: body-md
  input-rounded: sm
  input-padding-block-spacing: sm
  input-padding-inline-spacing: md
---

# Personal Design System

個人プロジェクト横断で使う自分用デザインシステム。形式は [google-labs-code/design.md](https://github.com/google-labs-code/design.md)（alpha）に準拠する。運用は**各プロジェクトのルートへこのファイルをコピー**する（正は [cancer/design-system](https://github.com/cancer/design-system)）。

本文の章構成。造形の原則とデザイントークンは由来の異なる独立した章であり、混ぜて語らない。残る2章は、その両方をシステム全体として扱う。

- **造形の原則** — 人間の知覚に由来する一般法則。このシステムから独立に成り立ち、トークンに依存しない
- **デザイントークン** — このシステムの設計判断。上部の YAML フロントマターが機械可読な定義、章本文がその意味
- **Do's and Don'ts** — 原則をトークンで画面へ適用するときの用法のガードレール
- **Maintenance** — このファイル自体の保守方針

## 造形の原則

造形の原則（principles of design）は、特定製品のローカルルールではなく、人間の知覚に接地した一般法則。発明せず適用する。

### 4大原則

- 近接（Proximity）は、関係の近い要素を近づけ、関係のない要素を離す。グループの区切りは線や色より余白で示す
- 整列（Alignment）は、すべての要素に共通の見えない基準線を通し、無意識に伝わる秩序をつくる
- 反復（Repetition）は、同じ視覚特徴を繰り返し、一貫性と読み方・使い方の学習可能性を生む
- コントラスト（Contrast）は、差を中途半端にせずはっきりつける。似て非なる状態をつくらない

### 発展

- 階層（Hierarchy）は、情報の重要度を視覚的な強さの順序に対応させる
- 余白（Whitespace）は「空き」ではなく能動的な要素で、詰め込まず余白そのもので意味を持たせる
- リズム（Rhythm）は、繰り返しの間隔に規則を持たせ、視線の流れを導く
- 強調（Emphasis）は、注目点を1つに絞る。すべてを強調することは何も強調しないことと同じ

## デザイントークン

このシステムの設計判断。上部の YAML フロントマターが機械可読な定義、この章がその意味。用法は Do's and Don'ts、保守は Maintenance が扱う。

トークンは層をなす。**値の尺度（primitive）→ 役割 → component**。フロントマターもこの章の節もこの順に並べる。意味（値を選ぶ理由・同時に変わる範囲）は役割の層で発生し、component の層で完成する。

役割と component の間の**共有結合層（いわゆる semantic 層）は作らない**。この層の実体は意味ではなく、複数の component が共有する「役割×部位」の行を束ねた重複除去の表であり、変更理由を共有する行が現れて初めて足す。1つの component からしか参照されない行は component の定義に直接書く。

### 値の尺度（Primitive）

尺度は値の候補集合を提供し、後続の判断が参照する範囲を狭める。それ自体は UI 上の意味を持たない。

#### Colors

色の尺度は primitive トーナルスケール（`colors`）だけ。色は値であって意味そのものを持たないため、`primary` を「色」としては持たない。`blue-500` のように色相＋段で名指す。個別に hex を決めず、OKLCH（知覚的に均一な色空間）で生成する。色相ごとに H を固定し、明度 L を全色相共通の段（`50`〜`950`）で刻む。彩度 C は各段が sRGB gamut に収まる範囲で中間段を最大にタペールする。これにより段が視覚的に均一になり、色相間で明度が揃う。

#### Typography

typography のトークンは、色と違い**最初から適用対象（文章階層・UI 部品）付きの意味単位**。サイズという尺度（見出しは 1.25 = Major Third のスケール比）は各トークンの中に埋まっており、primitive として独立させていない。フォントは `system-ui` / `ui-monospace` を既定にし、OS ネイティブの見た目に委ねる（読み込みコスト0・怠惰）。特定フォントに寄せたいプロジェクトは `fontFamily` だけ上書きする。

- 見出しは `h1`–`h3`、本文は `body-md`、補助は `body-sm` / `caption`、等幅は `code`、UI 部品のラベルは `label`
- `body-sm` / `caption` は本文より小さい補助サイズで、スケール比には乗せていない
- `label` はボタン・フォームラベル等の1行 UI テキスト用。本文と同サイズ帯でも、太さ（500）で識別し行間を詰める（1.2）
- `lineHeight` は本文 1.6・見出し 1.25–1.3。行長が伸びるほど行間を広げる

#### Layout & Spacing

`spacing` は 4px ベースの名前付きスケール（`xs`=4 … `3xl`=64）。要素間の余白はこのスケールからのみ選ぶ。中間値が必要になったら、まず隣の段で足りるか疑う。

#### Elevation & Depth

影は3段。フロントマター仕様に elevation 型が無いため、値はここで定義する。

```css
--shadow-sm: 0 1px 2px rgb(0 0 0 / 0.06);
--shadow-md: 0 4px 12px rgb(0 0 0 / 0.10);
--shadow-lg: 0 12px 32px rgb(0 0 0 / 0.14);
```

高さは意味に対応させる: `sm`=面の分離、`md`=浮いた要素（ドロップダウン）、`lg`=モーダル。ダークモードでは影が弱く見えるため、必要なら `neutral` の淡い段で縁を足して補う。

#### Shapes

角丸は `rounded` の4段（`sm` / `md` / `lg` / `full`）。`sm`=小要素（バッジ・入力）、`md`=カード・ボタン、`lg`=大きな面・モーダル、`full`=円/ピル。境界線は原則 1px・`neutral` の淡い段。

### Roles（役割層）

役割層（`roles`）は、`primary → blue` のように役割へどの色相族を割り当てるかを決める。利用者が画面から学習するのはこの対応であり、**意味の発生源はここ**。ただし役割は適用対象を決めないため、役割だけでは段（具体値）は決まらない。

役割層のトークンは `<役割>-color-<段>`（例 `danger-color-700` = `red-700`）として `roles` から機械的に導出する。名前に値種別 `color` を含めるのは、役割が色以外の尺度とも結びつきうるため、`danger-700` からは何の尺度を引いているか復元できないから。

現時点でこのシステムが定義する役割は、色相族への割り当てだけ。役割自体は複数の値種別と結びつきうる（名前に値種別を含めるのはそのため）。非色の役割（密度・強弱のような）はまだ定義していないので、非色の尺度には導出される役割層トークンが存在しない。必要になれば `roles` に足して同じ形で導出する。

役割へ色相を割り当てるときは、状態色（`danger`=red / `warning`=amber / `success`=green）が地やキーカラーから際立つようにする。そのため `primary` の色相をそれらと衝突させない。暖色をキーにすると、状態色の際立ちが落ちる。

### Components（意味の完成点）

値が一意に決まるのは component・部位・役割が揃った点で、**意味はここで完成する**。名前から値は導出できないため、1行ずつ明示定義する。トークンは **component（variant があれば variant まで）を単位に完結して定義し、variant 間で行を共有しない**。束ねてよいのは変更理由の共有が確認できた行だけ（共有結合層の条件）。横断で使う component のトークンだけを foundation に置き、プロジェクト固有の component はここへ足さず、消費側で役割層トークン・各尺度を参照して定義する。

- **screen** — 画面。部位は `text` / `text-muted` / `background` / `surface` / `border` / `accent`（強調テキスト）
- **link** — 本文中の遷移。部位は `text` のみで、書体・サイズは周囲の文に従う（トークンを持たない）。下線を保ち、色だけでリンクを示さない
- **icon** — 文中・UI 部品内の図像。色の行は `icon-color` = `currentColor` の1つで、置かれた文脈のテキスト色への委譲を値として持つ（分岐なし。文脈側が既に theme / state で分岐しているため）。状態色が必要な場面も独自の色を持たず、note / badge 等の親の `text` 色に乗る。サイズは決定を持たない — どの大きさが要るかは用途の要件で、消費側の範囲。どのグリフ（意味→形の対応）が必要かもプロジェクト固有の要件なので、グリフの語彙・セット選定は正では決めない。アイコンを必要とするプロジェクトは、グリフ名をローカル CSS へ直書きしない。**まず自プロジェクトの DESIGN.md の `components` に `icon-<意味>-glyph` トークンを定義し、それを消費する**。値はグリフを一意に指す ID（例 `lucide:thumbs-up`）。プロジェクト内では描画スタイルの揃った1セットから選び、混在させない（反復）。装飾目的のアイコンは支援技術から隠す（`aria-hidden`）
- **button** — 操作。variant は役割そのもの（`primary` / `danger` / `neutral`）。色の部位は `surface` / `text`。非色は `text-typography`（=`label`）・`rounded`（=`md`）・`padding-block` / `padding-inline`（=`sm` / `lg`）
- **note** — 状態の告知面。variant は状態役割（`success` / `warning` / `danger` / `neutral`）。色の部位は `surface` / `border` / `text`。非色は `text-typography`（=`body-sm`）・`rounded`（=`md`）・`padding-block` / `padding-inline`（=`sm` / `md`）
- **card** — 面の分離。部位は `surface` / `border`。非色は `rounded`（=`md`）・`padding`（=`lg`）・`shadow`（=`sm`。Elevation の「面の分離」に対応）
- **badge** — 小さな状態表示。variant は状態役割（note と同じ4種）。色の部位は `surface` / `text`。非色は `text-typography`（=`caption`）・`rounded`（=`sm`。Shapes の「小要素」）・`padding-block` / `padding-inline`（=`xs` / `sm`）
- **input** — 入力欄。色の部位は `surface` / `border` / `text` / `placeholder`。非色は `text-typography`（=`body-md`）・`rounded`（=`sm`）・`padding-block` / `padding-inline`（=`sm` / `md`）

値の参照先は、その値種別に役割が定義されているかで変わる。**色は役割層トークンを経由し、primitive を直接参照しない**。族の付け替えを `roles` の1行に閉じ、component に色相族を知らせないためである。例外は文脈への委譲。`icon-color` のように **CSS の委譲キーワード `currentColor` を値に持つ色の行**は、役割層を参照せず theme / state の分岐も持たない。追従先の文脈が既に分岐しているためで、fontFamily を `system-ui` に委ねるのと同じく、委譲という決定を値として焼く。**typography / rounded / spacing / shadow は尺度のキーを直接参照する**。これらの値種別にはまだ役割を定義しておらず、経由すべき役割層トークンが存在しない（Roles 節）。

theme（light/dark）や state（hover / focus 等）は、値と意味のどちらも持たない **modifier**。同じ意味単位の「見え方」を分岐させるだけで別物にはしないので、`-dark` のようにトークン名へ焼き付けず、component トークンの分岐キーとして持つ。theme は `light:` / `dark:`、state はそれに重ねて `<state>-light:` / `<state>-dark:`。theme・state で変わるのは色だけなので、分岐を持つのも色の行だけ。state の分岐は対話的 component にだけ足す。現在の分岐は次のとおり。button は `hover` / `active` / `focus` / `disabled`。link は `hover` / `active` / `focus`。input は `hover` / `focus` / `disabled` / `invalid`。`visited` は定義しない — 慣習の紫に対応する色相族が尺度に無く、区別が必要になったとき族ごと足す。note / badge / card / screen は非対話なので state を持たない。

focus は**ブラウザ既定のフォーカスリングに委ねる**（typography を `system-ui` に委ねるのと同じ判断）。既定リングは UA が地とのコントラストを自動確保する（Chrome の二色リング等）。WCAG 1.4.11 も「外観が user agent によって決まり作者が変更していない場合」を非テキストコントラスト要件から除外しており、変更した瞬間に 3:1 の立証責任が作者へ移る。よってリングは消さない・塗り替えない。focus の色トークンは持たない。`disabled` の文字×地は WCAG の inactive 例外によりコントラスト要件（AA）の対象外で、AA 検証からも除外する。ただし **disabled でも役割の色相族は保つ**（button-danger の disabled は danger の淡い段）。無彩へ落とすと variant 間の区別が消え、利用者が学習した役割⇔色相の対応（意味の発生源）を state が破壊してしまうため。

文字色×地色のペアは WCAG AA（4.5:1）を満たす段を選ぶ。段の選定パターン: button の有彩色 surface は light=700段＋`neutral-color-50` 文字・dark=500段＋`neutral-color-950` 文字。note は淡い地（light=100 / dark=950）に濃い文字（light=900 / dark=200）・中間の縁（light=300 / dark=800）。

## Do's and Don'ts

この見た目をどう当てるか。視覚と用法のガードレール。

### Do

- `primary`（強調の役割）は主要アクション1つに集中させる。画面内で多用すると主張が薄まる
- 余白を惜しまず取る。要素を詰め込むより、`spacing` の一段上を選ぶ
- 書体は sans + mono の2種に留める。強調は太さ（`fontWeight`）と大きさで作る
- 角丸は `rounded` スケールに揃える。近い要素で半径を変えない

### Don't

- 純黒 `#000` をテキストに直接使わない。`neutral` の最暗ではない段を使う
- `primary` のボタンを隣り合わせに2つ置かない。主要アクションは画面に1つ
- `success` / `warning` / `danger` の色相を装飾目的に使わない。状態表示専用
- スケール外の中間サイズ（余白・文字・角丸）を持ち込まない。まず隣の段で足りるか疑う
- 値が同じだからと、別の適用対象のトークンを借りない（例: input の縁に `screen-border-color` を使う）。値の一致は意味の一致を保証せず、借り先の変更に巻き込まれる
- フォーカスリングを変更しない。`outline: none` で消すことも、独自色への塗り替えもしない（既定＝UA 責務、変更＝作者が 3:1 を負う）

## Maintenance

このファイル自体の運用ルール（デザインの見た目ではなく、システムの保守方針）。

- このファイルは、primitive スケール・role→スケール参照・**横断 component のトークン**（意味の完成点）を持つ。役割と component の間の共有結合層（semantic 層）は、複数 component が変更理由を共有する行が現れるまで作らない。プロジェクト固有の component は消費側に属し、ここへ足さない
- トークンを**足す**基準は「抽象的な役割を名指すか」。ドメインに依存しない設計上の役割（変更理由を1つ持つ知識の単位）なら、使用が1箇所でも足す。使用箇所の数・場所は基準にしない。特定ドメイン・用途に固有の具体指示は、値が2箇所以上で一致してもトークンにしない（それはローカルCSSへ）
- component トークンの値は、色なら役割層トークン（`<役割>-color-<段>`）を参照し、primitive を直接参照しない。非色（typography / rounded / spacing / shadow）なら尺度のキー（`md` / `body-sm` 等）を直接参照する。役割を定義していない値種別には、経由すべき役割層トークンが無い。文脈へ委譲する色の行だけは例外で、キーワード `currentColor` を値に持ち、分岐を持たない
- プロジェクトがアイコン（グリフ）を必要とするときは、グリフ名をローカル CSS へ直書きしない。まずプロジェクト側 DESIGN.md の `components` に `icon-<意味>-glyph` トークンを定義してから消費する。グリフの語彙はプロジェクト固有の要件なので、この正へは足さない
- theme・state をトークン名へ焼き付けない（`-dark` のように）。これらは modifier であり、component トークンの分岐キーとして持つ
- 文字色×地色のペアを足す・変えるときは AA（4.5:1）を満たすことを検証する
- プロジェクト固有の微調整は、そのプロジェクトのローカルCSSで吸収する。ここには持ち込まない
- 生の16進カラーや px 値をコンポーネントに直書きしない。トークン経由で引く
- この正ファイルを1プロジェクトの都合で書き換えない。横断でコピーされる正のため、変更は全プロジェクトへ波及する前提で扱う
