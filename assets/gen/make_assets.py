#!/usr/bin/env python3
"""一笔 · EULERTRAIL 的美术母图与派生资产，一次性可复现地生成到盘上。

为什么仓内自带生成器而不是等主库发图：本仓不在 `007_美术资产/icons` 的清单里
（实测 `ls 007_美术资产/icons | grep euler` 为空），等下去就是永远没有图标。

视觉母题由玩法决定，不是凭审美编：这个游戏的本体是"平面格点 + 若干条互不重复的
迹（trail）"，所以母图就是一块 5×5 格点盘、上面走过三条不同色的迹、笔头停在最后一枚
图钉上。颜色直接取运行时真在用的那几支墨水（js/view.js 的 INK、css/game.css 的
--bg / --amber / --cyan / --violet），图标与屏幕因此是同一套语言。

确定性：全脚本只有 `LCG` 一个随机源且种子写死；字体按候选列表回落；同样的输入必出
同样的字节。母图统一在 1024² 上绘制，再 LANCZOS 降到各目标尺寸；平滑量（径向底、
暗角）在 1/4 分辨率解析式算好后放大，肉眼与耗时都划算。

用法:  python3 assets/gen/make_assets.py          # 全量重生成
       python3 assets/gen/make_assets.py --check  # 只列盘上产物的尺寸/字节
"""
from __future__ import annotations

import argparse
import math
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:  # pragma: no cover
    sys.exit('需要 Pillow（与组织量具 make_icons.py 同源依赖）：python3 -m pip install pillow')

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..'))
ICONS = os.path.join(REPO, 'icons')
IMAGES = os.path.join(REPO, 'assets', 'img')

MASTER = 1024

# 与 js/view.js 的 INK / css/game.css 的色令牌对齐：改了那边要改这里，两边都有实测断言。
INK = {
    'amber': (232, 176, 75),
    'cyan': (95, 201, 224),
    'violet': (183, 139, 242),
    'green': (127, 208, 138),
    'rose': (242, 116, 139),
    'blue': (121, 168, 255),
}
BG_CORE = (27, 34, 48)
BG_EDGE = (9, 12, 17)
PIN = (143, 162, 189)
PIN_HOT = (244, 247, 251)
GRID = (226, 232, 240)

N = 5  # 5×5 图钉，和 js/core/graph.js 的邻接一致：上下左右，不斜连


class LCG:
    """唯一随机源：s = (A*s + C) mod 2^32，种子写死 ⇒ 逐字节可复现。"""

    A, C, M = 1103515245, 12345, 1 << 32

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def byte(self):
        self.s = (self.A * self.s + self.C) % self.M
        return (self.s >> 16) & 0xFF

    def unit(self):
        return self.byte() / 255.0

    def range(self, a, b):
        return a + (b - a) * self.unit()


def node(rc):
    r, c = rc
    return r * N + c


def adjacent(a, b):
    return abs(a[0] - b[0]) + abs(a[1] - b[1]) == 1


# 三条迹：amber 12 边、cyan 5 边、violet 5 边，两两不共边 —— 这正是玩法本身。
TRAILS = [
    ('amber', [(1, 0), (1, 1), (1, 2), (1, 3), (1, 4), (2, 4), (3, 4), (3, 3), (3, 2), (3, 1), (3, 0), (2, 0), (2, 1)]),
    ('cyan', [(0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (1, 4)]),
    ('violet', [(2, 2), (2, 3), (3, 3), (4, 3), (4, 2), (4, 1)]),
]
# 社交卡多跑两支，画面读起来像一局的中盘而不是示意图
TRAILS_WIDE = TRAILS + [('green', [(0, 2), (1, 2)]), ('blue', [(1, 3), (2, 3)])]


def selfcheck_trails(trails):
    """母图必须是**合法的**欧拉迹集合：邻接成立 + 全局零重边。非法就直接退出，不静默出图。"""
    seen = set()
    for color, path in trails:
        for a, b in zip(path, path[1:]):
            if not adjacent(a, b):
                raise SystemExit(f'母图非法：{color} 的 {a}->{b} 不是格点邻接')
            e = frozenset((node(a), node(b)))
            if e in seen:
                raise SystemExit(f'母图非法：{color} 重复了边 {sorted(e)}（迹不允许重边）')
            seen.add(e)
    return len(seen)


CJK_FONT = ['/System/Library/Fonts/PingFang.ttc', '/System/Library/Fonts/Hiragino Sans GB.ttc',
            '/System/Library/Fonts/Supplemental/Hiragino Sans GB.ttc',
            '/System/Library/Fonts/STHeiti Medium.ttc',
            '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
MONO_FONT = ['/System/Library/Fonts/SFNSMono.ttf', '/System/Library/Fonts/Menlo.ttc',
             '/System/Library/Fonts/Supplemental/Menlo.ttc',
             '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf']


def font(candidates, size):
    for path in candidates:
        if not os.path.exists(path):
            continue
        for idx in range(4):
            try:
                return ImageFont.truetype(path, size, index=idx)
            except OSError:
                continue
    raise SystemExit(f'找不到字体，候选：{candidates}')


def smoothstep(t):
    return t * t * (3 - 2 * t)


def radial_bg(size, core=BG_CORE, edge=BG_EDGE, cx=0.5, cy=0.42, power=1.0):
    """径向底在 1/4 分辨率解析式算出再 bicubic 放大：渐变本就平滑，放大无台阶。"""
    q = max(8, size // 4)
    img = Image.new('RGB', (q, q), edge)
    px = img.load()
    ox, oy, R = cx * q, cy * q, q * 1.16
    for y in range(q):
        dy = (y - oy) / R
        for x in range(q):
            dx = (x - ox) / R
            t = smoothstep(min(1.0, (math.hypot(dx, dy) * 1.35) ** power))
            px[x, y] = (int(edge[0] + (core[0] - edge[0]) * (1 - t)),
                        int(edge[1] + (core[1] - edge[1]) * (1 - t)),
                        int(edge[2] + (core[2] - edge[2]) * (1 - t)))
    return img.resize((size, size), Image.BICUBIC)


def noise_field(w, h, seed):
    rnd = LCG(seed)
    n = w * h
    buf = bytearray(n)
    for i in range(n):
        buf[i] = rnd.byte()
    return Image.frombuffer('L', (w, h), bytes(buf), 'raw', 'L', 0, 1)


def lattice_layout(size, margin):
    m = size * margin
    cell = (size - 2 * m) / (N - 1)
    return {(r, c): (m + c * cell, m + r * cell) for r in range(N) for c in range(N)}, cell


def draw_scene(margin=0.17, compact=False, trails=None, glow=True, size=MASTER):
    """一张 size² 母图。compact=True 给 16/32px favicon：去掉网格与噪点、加粗墨线。"""
    S = size
    img = radial_bg(S).convert('RGBA')
    pts, cell = lattice_layout(S, margin)
    trails = trails or TRAILS
    scale = S / MASTER

    if not compact:
        # 噪点：母图原分辨率逐像素生成（不放大，放大必糊成迷彩块），叠白/叠黑各 5%/6% 幅度，
        # 只给纯解析渐变一点呼吸感，不改变明度基准。
        g = noise_field(S, S, 0xB0A2)
        img = Image.composite(Image.new('RGBA', (S, S), (255, 255, 255, 255)), img,
                              g.point(lambda v: int(max(0, v - 128) * 0.05)))
        img = Image.composite(Image.new('RGBA', (S, S), (0, 0, 0, 255)), img,
                              g.point(lambda v: int(max(0, 128 - v) * 0.06)))

    d = ImageDraw.Draw(img)
    if not compact:
        for r in range(N):
            for c in range(N):
                p = pts[(r, c)]
                for nr, nc in ((r, c + 1), (r + 1, c)):
                    if nr < N and nc < N:
                        d.line([p, pts[(nr, nc)]], fill=(*GRID, 24), width=max(1, int(2 * scale)))

    lw = S * (0.052 if compact else 0.031)
    for color, path in trails:
        poly = [pts[p] for p in path]
        col = INK[color]
        if glow and not compact:
            halo = Image.new('RGBA', (S, S), (0, 0, 0, 0))
            ImageDraw.Draw(halo).line(poly, fill=(*col, 66), width=int(lw * 2.5), joint='curve')
            img.alpha_composite(halo.filter(ImageFilter.GaussianBlur(S * 0.012)))
            d = ImageDraw.Draw(img)
        d.line(poly, fill=(3, 4, 6, 190), width=int(lw * 1.42), joint='curve')  # 墨下的暗槽
        d.line(poly, fill=(*col, 255), width=int(lw), joint='curve')
        for p in poly[1:-1]:
            d.ellipse([p[0] - lw / 2, p[1] - lw / 2, p[0] + lw / 2, p[1] + lw / 2], fill=(*col, 255))

    inked = {p for _, path in trails for p in path}
    pr = S * (0.020 if compact else 0.0125)
    for key, p in pts.items():
        hot = key in inked
        col = PIN_HOT if hot else PIN
        a = 255 if hot else 150
        d.ellipse([p[0] - pr, p[1] - pr, p[0] + pr, p[1] + pr], fill=(*col, a))
        if hot and not compact:
            d.ellipse([p[0] - pr * 2.1, p[1] - pr * 2.1, p[0] + pr * 2.1, p[1] + pr * 2.1],
                      outline=(*col, 70), width=max(1, int(S * 0.0016)))

    # 笔头停在第一条迹的末点上：抓的是"正在画"的那一瞬，不是终盘照片。
    tip = pts[trails[0][-1][-1]]
    tr = S * (0.030 if compact else 0.019)
    if glow and not compact:
        pen = Image.new('RGBA', (S, S), (0, 0, 0, 0))
        pd = ImageDraw.Draw(pen)
        pd.ellipse([tip[0] - tr * 2.4, tip[1] - tr * 2.4, tip[0] + tr * 2.4, tip[1] + tr * 2.4],
                   fill=(*INK['amber'], 120))
        img.alpha_composite(pen.filter(ImageFilter.GaussianBlur(S * 0.016)))
        d = ImageDraw.Draw(img)
    d.ellipse([tip[0] - tr, tip[1] - tr, tip[0] + tr, tip[1] + tr], fill=(255, 255, 255, 235))
    d.ellipse([tip[0] - tr * 0.62, tip[1] - tr * 0.62, tip[0] + tr * 0.62, tip[1] + tr * 0.62],
              fill=(*INK['amber'], 255))

    if not compact:
        mask = vignette_mask(S, S, strength=58)
        img = Image.composite(Image.new('RGBA', (S, S), (0, 0, 0, 255)), img, mask)
    return img


def vignette_mask(w, h, strength=58, cx=0.5, cy=0.46):
    """角落压暗的 L 蒙版：smoothstep(半径) 解析式，1/4 分辨率生成后 bicubic 放大。"""
    qw, qh = max(8, w // 4), max(8, h // 4)
    mask = Image.new('L', (qw, qh), 0)
    px = mask.load()
    for y in range(qh):
        dy = (y - cy * qh) / (qh * 0.62)
        for x in range(qw):
            dx = (x - cx * qw) / (qw * 0.62)
            t = max(0.0, math.hypot(dx, dy) - 0.55) / 0.65
            px[x, y] = int(strength * smoothstep(min(1.0, t)))
    return mask.resize((w, h), Image.BICUBIC)


def squircle(img, radius_ratio=0.2237):
    S = img.width
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * radius_ratio), fill=255)
    out = img.convert('RGBA')
    out.putalpha(mask)
    return out


def save(src_img, path, size, *, round_icon=True, flatten=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im = src_img.convert('RGBA').resize((size, size), Image.LANCZOS)
    if round_icon and size >= 64:
        im = squircle(im)
    if flatten is not None:
        base = Image.new('RGBA', (size, size), (flatten[0], flatten[1], flatten[2], 255))
        base.alpha_composite(im)
        im = base
    im.save(path, 'PNG', optimize=True)
    return path


# ------------------------------------------------------------------ 游戏内纹理 / sprite
def lattice_tile(size=128, alpha=17):
    """无缝格点：view.js 拿它当棋盘面的 CanvasPattern，取代原来手绘的那层直线网格。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    step = size / 4
    for i in range(4):
        p = int(round(i * step))
        d.line([(p, 0), (p, size)], fill=(*GRID, alpha), width=1)
        d.line([(0, p), (size, p)], fill=(*GRID, alpha), width=1)
    px = img.load()
    rnd = LCG(0x71A2)
    for _ in range(int(size * size * 0.0022)):
        x, y = int(rnd.range(0, size - 1)), int(rnd.range(0, size - 1))
        _, _, _, a = px[x, y]
        px[x, y] = (GRID[0], GRID[1], GRID[2], max(a, alpha + 22))
    return img


def pin_sprite(size=64, tint=PIN_HOT, ring=90):
    """一枚图钉：外发光 + 可选环 + 内核 + 高光。view.js 用 drawImage 画全部图钉。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    c = size / 2
    glow = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gr = size * 0.30
    gd.ellipse([c - gr, c - gr, c + gr, c + gr], fill=(*tint, 96))
    img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(size * 0.10)))
    d = ImageDraw.Draw(img)
    if ring:
        d.ellipse([c - gr, c - gr, c + gr, c + gr], outline=(*tint, ring), width=max(1, int(size * 0.03)))
    r = size * 0.155
    d.ellipse([c - r, c - r, c + r, c + r], fill=(*tint, 255))
    d.ellipse([c - r * 0.45, c - r * 1.55, c + r * 0.35, c - r * 0.55], fill=(255, 255, 255, 200))
    return img


def glow_sprite(size=128, tint=INK['amber'], power=2.6):
    """软光斑：笔头光晕与提示涟漪共用一张，tint 在绘制时乘色相覆盖。"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    px = img.load()
    c = size / 2
    for y in range(size):
        for x in range(size):
            t = math.hypot(x - c, y - c) / c
            if t >= 1:
                continue
            px[x, y] = (*tint, int(255 * (1 - t) ** power))
    return img


def paper_grain(size=256, seed=0x0A11):
    """整页 CSS 叠加层：白色像素配 0..15 的极淡 alpha，只取 L 无方向 ⇒ 平铺无接缝。"""
    alpha = noise_field(size, size, seed).point(lambda v: v // 17)
    out = Image.new('RGBA', (size, size), (255, 255, 255, 0))
    out.putalpha(alpha)
    return out


# ------------------------------------------------------------------ 社交卡
# og_cover 用的字号在 main() 里构造（字体探测只在生成时做一次），这里是声明位。
CJK_96 = CJK_44 = CJK_34 = CJK_24 = MONO_44 = None


def og_cover(path, w=1200, h=630):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img = radial_bg(MASTER).convert('RGBA').resize((w, h), Image.LANCZOS)
    img = Image.composite(Image.new('RGBA', (w, h), (0, 0, 0, 255)), img, vignette_mask(w, h, strength=46))
    plate = draw_scene(margin=0.15, trails=TRAILS_WIDE, size=MASTER).resize((int(h * 0.78), int(h * 0.78)), Image.LANCZOS)
    base = Image.new('RGBA', plate.size, (*BG_EDGE, 255))
    base.alpha_composite(plate)
    img.alpha_composite(base, (int(w * 0.048), int(h * 0.11)))
    d = ImageDraw.Draw(img)
    x0 = int(w * 0.545)
    rows = [
        ('一笔', CJK_96, (*PIN_HOT, 255), int(h * 0.15)),
        ('EULERTRAIL', MONO_44, (*INK['amber'], 255), int(h * 0.15) + 118),
        ('在格点上描完所有的边', CJK_34, (196, 205, 218, 255), int(h * 0.50)),
        ('每条边只能描一次', CJK_34, (196, 205, 218, 255), int(h * 0.50) + 48),
        ('笔数上限由欧拉定理算出', CJK_34, (196, 205, 218, 255), int(h * 0.50) + 96),
        ('max(1, 奇点数 / 2)', CJK_44, (*INK['cyan'], 255), int(h * 0.50) + 148),
        ('定理 · 构造 · 穷举 三遍复核同一关', CJK_24, (143, 162, 189, 255), int(h * 0.50) + 214),
    ]
    for text, fnt, fill, y in rows:
        box = d.textbbox((x0, y), text, font=fnt)
        if box[2] > w - 18:   # 排印溢出比难看更糟：那是资产没做完
            raise SystemExit(f'社交卡文字溢出画布：{text!r} 右边界 {box[2]} > {w - 18}')
        d.text((x0, y), text, font=fnt, fill=fill)
    img.convert('RGB').save(path, 'PNG', optimize=True)
    return path


def main():
    global CJK_96, CJK_44, CJK_34, CJK_24, MONO_44
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只列盘上产物的尺寸/字节')
    args = ap.parse_args()

    if args.check:
        total = 0
        for base in (ICONS, IMAGES):
            for f in sorted(os.listdir(base)) if os.path.isdir(base) else []:
                if not f.endswith('.png'):
                    continue
                p = os.path.join(base, f)
                with Image.open(p) as im:
                    print(f'{os.path.relpath(p, REPO):34s} {im.width:>5d}x{im.height:<5d} {im.mode:4s} {os.path.getsize(p):>8d}B')
                total += 1
        print(f'{total} 张 PNG 在盘')
        return

    CJK_96, CJK_44, CJK_34, CJK_24 = (font(CJK_FONT, 96), font(CJK_FONT, 44),
                                      font(CJK_FONT, 34), font(CJK_FONT, 24))
    MONO_44 = font(MONO_FONT, 44)
    selfcheck_trails(TRAILS)
    n_edges = selfcheck_trails(TRAILS_WIDE)
    master = draw_scene(margin=0.17)
    compact = draw_scene(margin=0.115, compact=True)
    maskable = draw_scene(margin=0.27)

    targets = [
        ('icon-1024.png', 1024, master, True, None),
        ('icon-512.png', 512, master, True, None),
        ('icon-192.png', 192, master, True, None),
        ('icon-152.png', 152, master, True, None),
        ('icon-120.png', 120, master, True, None),
        ('icon-96.png', 96, master, True, None),
        ('icon-64.png', 64, master, True, None),
        ('icon-48.png', 48, master, True, None),
        ('favicon-32.png', 32, compact, False, None),
        ('favicon-16.png', 16, compact, False, None),
        # iOS 自己加遮罩与圆角，这里必须给不透明方图
        ('apple-touch-icon.png', 180, master, False, (10, 13, 19)),
        ('icon-maskable-512.png', 512, maskable, False, (BG_EDGE[0], BG_EDGE[1], BG_EDGE[2])),
    ]
    wrote = [save(src, os.path.join(ICONS, name), size, round_icon=rnd, flatten=flat)
             for name, size, src, rnd, flat in targets]

    tex = [
        ('lattice-tile.png', lattice_tile(128)),
        ('pin-sprite.png', pin_sprite(64, PIN_HOT)),
        ('pin-dim-sprite.png', pin_sprite(64, PIN, ring=0)),
        ('pen-glow.png', glow_sprite(128, INK['amber'])),
        ('hint-glow.png', glow_sprite(128, (120, 220, 255))),
        ('paper-grain.png', paper_grain(256)),
    ]
    os.makedirs(IMAGES, exist_ok=True)
    for name, im in tex:
        p = os.path.join(IMAGES, name)
        im.save(p, 'PNG', optimize=True)
        wrote.append(p)

    wrote.append(og_cover(os.path.join(IMAGES, 'og-cover.png')))
    print(f'母图 {n_edges} 条边（0 重边、全部格点邻接）；写出 {len(wrote)} 个文件')
    for p in wrote:
        print(' ', os.path.relpath(p, REPO))


if __name__ == '__main__':
    main()
