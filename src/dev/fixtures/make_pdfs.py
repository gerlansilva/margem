#!/usr/bin/env python3
"""Gera PDFs de teste em /tmp/margem-fixtures (ou no diretório passado).

Uso: python3 make_pdfs.py [saida]
Requer: pdflatex (+babel brazilian, tikz, booktabs), reportlab, pikepdf, Pillow.
"""
import os, subprocess, sys, tempfile, shutil, random
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw, ImageFont

OUT = sys.argv[1] if len(sys.argv) > 1 else '/tmp/margem-fixtures'
os.makedirs(OUT, exist_ok=True)

P = [
 "A Educação Estatística consolidou-se no Brasil como campo de pesquisa a partir da década de 1990, com a criação de grupos de estudo e a realização de congressos específicos. Nesse movimento, a formação de professores ocupou lugar central nas discussões acadêmicas.",
 "Neste trabalho, investigamos como professores dos anos iniciais compreendem a variabilidade em situações cotidianas. A amostra foi composta por 248 professores de matemática de escolas públicas, selecionados por conveniência em três estados brasileiros.",
 "O referencial teórico apoia-se na noção de letramento estatístico, entendido como a capacidade de interpretar criticamente informações quantitativas. Segundo essa perspectiva, compreender gráficos e tabelas exige conhecimento contextual e atitude investigativa.",
 "Os procedimentos metodológicos envolveram a aplicação de um questionário com doze questões abertas, seguida de entrevistas semiestruturadas. A análise dos dados seguiu os princípios da análise de conteúdo, com categorias emergentes e validação entre pares.",
 "Os resultados indicam que a maioria dos participantes reconhece a variação, mas poucos conseguem interpretá-la em termos probabilísticos. Observou-se, ainda, dificuldade recorrente na distinção entre média, mediana e moda em contextos não escolares.",
 "Considerando as implicações pedagógicas, argumentamos que programas de formação continuada devem articular situações-problema autênticas, uso de tecnologias e reflexão sobre a prática docente, de modo a favorecer o desenvolvimento do pensamento estatístico.",
 "Extraordinariamente, a institucionalização desses conhecimentos depende de políticas educacionais consistentes e do reconhecimento da interdisciplinaridade característica da área. Descontextualizadamente, contudo, as avaliações em larga escala pouco contribuem.",
]
def para(i, n=1):
    return " ".join(P[(i + k) % len(P)] for k in range(n))

# ------------------------------------------------------------- LaTeX 2 colunas
def latex(name, twocol, pages_hint=6):
    body = []
    body.append(r"\section{Introdução}")
    body.append(para(0, 3) + r"\footnote{Esta nota de rodapé esclarece que o termo ``campo'' é usado no sentido de Bourdieu.}")
    body.append(para(3, 3))
    body.append(r"\section{Referencial teórico}")
    body.append(para(2, 4))
    body.append(r"\subsection{Letramento estatístico}")
    body.append(para(5, 3) + r"\footnote{Segundo Gal (2002), o letramento envolve conhecimento e disposição.}")
    body.append(r"\section{Metodologia}")
    body.append(para(1, 3))
    body.append(r"""
\begin{table}[h]\centering\caption{Distribuição da amostra por estado.}
\begin{tabular}{lrr}\toprule Estado & Professores & Percentual\\\midrule
São Paulo & 120 & 48,4\\ Minas Gerais & 78 & 31,5\\ Paraíba & 50 & 20,2\\\midrule Total & 248 & 100,0\\\bottomrule\end{tabular}
\end{table}""")
    body.append(para(4, 4))
    body.append(r"""
\begin{figure}[h]\centering
\begin{tikzpicture}[scale=0.8]
\draw[->] (0,0)--(5,0) node[right]{x}; \draw[->] (0,0)--(0,3) node[above]{y};
\fill[blue!50] (0.5,0) rectangle (1,1.2); \fill[red!50] (1.5,0) rectangle (2,2.4);
\fill[green!50] (2.5,0) rectangle (3,1.8); \fill[orange!60] (3.5,0) rectangle (4,2.9);
\end{tikzpicture}
\caption{Frequência por categoria de resposta.}\end{figure}""")
    for k in range(4):
        body.append(para(k, 3))
    body.append(r"\section{Resultados e discussão}")
    for k in range(6):
        body.append(para(k + 2, 3))
    body.append(r"\section{Considerações finais}")
    body.append(para(5, 3))
    refs = r"""
\begin{thebibliography}{9}
\bibitem{gal} GAL, Iddo. Adults' statistical literacy: meanings, components, responsibilities. \textit{International Statistical Review}, v. 70, n. 1, p. 1-25, 2002.
\bibitem{lopes} LOPES, Celi Espasandin. O ensino da estatística e da probabilidade na educação básica. \textit{Cadernos Cedes}, v. 28, n. 74, p. 57-73, 2008.
\bibitem{batanero} BATANERO, Carmen. \textit{Didáctica de la estadística}. Granada: Universidad de Granada, 2001.
\end{thebibliography}"""
    doc = r"""\documentclass[10pt,%s,a4paper]{article}
\usepackage[T1]{fontenc}\usepackage[utf8]{inputenc}\usepackage[brazilian]{babel}
\usepackage{booktabs,graphicx,tikz,xcolor}
\renewcommand{\refname}{Referências}
\begin{document}
\title{Letramento estatístico de professores: um estudo no Brasil}
\author{Ana Souza \and Carlos Pereira}\date{}
\twocolumn[\maketitle\begin{abstract}\noindent Este artigo investiga o letramento estatístico de professores dos anos iniciais em três estados brasileiros, com 248 participantes.\end{abstract}\vspace{1em}]
%s
%s
\end{document}""" % ("twocolumn" if twocol else "onecolumn", "\n\n".join(body), refs)
    if not twocol:
        doc = doc.replace(r"\twocolumn[\maketitle\begin{abstract}", r"\maketitle\begin{abstract}").replace(r"\end{abstract}\vspace{1em}]", r"\end{abstract}")
    d = tempfile.mkdtemp(prefix='mm_')
    open(os.path.join(d, 'a.tex'), 'w').write(doc)
    for _ in range(2):
        subprocess.run(['pdflatex', '-interaction=nonstopmode', 'a.tex'], cwd=d, capture_output=True)
    shutil.copy(os.path.join(d, 'a.pdf'), os.path.join(OUT, name))
    shutil.rmtree(d)

latex('artigo-2colunas.pdf', True)
latex('artigo-1coluna.pdf', False)

# ------------------------------------------------------------- 1 página
c = canvas.Canvas(os.path.join(OUT, 'uma-pagina.pdf'), pagesize=A4)
c.setFont('Helvetica-Bold', 18); c.drawString(72, 760, 'Nota técnica de uma página')
c.setFont('Helvetica', 11)
y = 730
for line in "Este documento tem apenas uma página. A média aritmética de 4, 8 e 12 é 8. Acentuação: ação, coração, avô, pingüim.".split('. '):
    c.drawString(72, y, line + '.'); y -= 16
c.save()

# ------------------------------------------------------------- 200 páginas
im = Image.new('RGB', (600, 300), 'white'); dr = ImageDraw.Draw(im)
for i in range(8): dr.rectangle([30 + i*65, 280 - (i+1)*28, 80 + i*65, 280], fill=(40*i % 255, 120, 200 - 20*i))
im_path = os.path.join(OUT, '_fig.png'); im.save(im_path)
c = canvas.Canvas(os.path.join(OUT, 'grande-200p.pdf'), pagesize=A4)
random.seed(1)
for p in range(1, 201):
    c.setFont('Helvetica-Bold', 13); c.drawString(72, 790, f'Capítulo {p // 10 + 1} — seção {p}')
    c.setFont('Times-Roman', 11)
    y = 760
    for k in range(3):
        words = para(p + k, 1).split()
        line = ''
        for w in words:
            if c.stringWidth(line + ' ' + w, 'Times-Roman', 11) > 450:
                c.drawString(72, y, line.strip()); y -= 14; line = ''
            line += ' ' + w
        c.drawString(72, y, line.strip()); y -= 26
    if p % 5 == 0:
        c.drawImage(ImageReader(im_path), 100, y - 230, width=360, height=180); y -= 250
    c.setFont('Helvetica', 9); c.drawCentredString(297, 40, str(p))
    c.showPage()
c.save()

# ------------------------------------------------------------- só imagem
img = Image.new('RGB', (1240, 1754), 'white'); dr = ImageDraw.Draw(img)
try: font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 36)
except Exception: font = ImageFont.load_default()
for i, t in enumerate(['Documento escaneado sem camada de texto', 'Resultados: média 8,5 e desvio 1,2.', 'Fim da página.']):
    dr.text((100, 150 + i*70), t, fill='black', font=font)
sp = os.path.join(OUT, '_scan.png'); img.save(sp)
c = canvas.Canvas(os.path.join(OUT, 'so-imagem.pdf'), pagesize=A4)
c.drawImage(ImageReader(sp), 0, 0, width=A4[0], height=A4[1]); c.showPage(); c.save()

# ------------------------------------------------------------- senha
import pikepdf
with pikepdf.open(os.path.join(OUT, 'uma-pagina.pdf')) as pdf:
    pdf.save(os.path.join(OUT, 'com-senha.pdf'), encryption=pikepdf.Encryption(user='segredo', owner='segredo'))

# ------------------------------------------------------------- página rotacionada (/Rotate 90)
with pikepdf.open(os.path.join(OUT, 'artigo-1coluna.pdf')) as pdf:
    while len(pdf.pages) > 2:
        del pdf.pages[-1]
    pdf.pages[0].Rotate = 90
    pdf.save(os.path.join(OUT, 'rotacionado.pdf'))

# ------------------------------------------------------------- paisagem: conteúdo girado + /Rotate (texto em pé no espaço do PDF, de pé na tela)
c = canvas.Canvas(os.path.join(OUT, '_land.pdf'), pagesize=A4)
c.saveState(); c.translate(0, 842); c.rotate(-90)
c.setFont('Helvetica-Bold', 18); c.drawString(72, 520, 'Quadro em página paisagem')
c.setFont('Times-Roman', 12)
for i, line in enumerate(["A amostra foi composta por 248 professores de matemática.", "Este texto está girado no espaço do PDF e de pé na tela.", "Cada linha deve ser lida na ordem natural, de cima para baixo."]):
    c.drawString(72, 490 - 18 * i, line)
c.restoreState(); c.save()
with pikepdf.open(os.path.join(OUT, '_land.pdf')) as pdf:
    pdf.pages[0].Rotate = 270
    pdf.save(os.path.join(OUT, 'paisagem.pdf'))
os.remove(os.path.join(OUT, '_land.pdf'))

# ------------------------------------------------------------- MediaBox deslocada
with pikepdf.open(os.path.join(OUT, 'uma-pagina.pdf')) as pdf:
    pg = pdf.pages[0]
    pg.MediaBox = [40, 60, 40 + 595.28, 60 + 841.89]
    pg.CropBox = pg.MediaBox
    # desloca o conteúdo junto
    pg.Contents = pdf.make_stream(b'1 0 0 1 40 60 cm\n' + pg.Contents.read_bytes() if not isinstance(pg.Contents, pikepdf.Array) else b'')
    pdf.save(os.path.join(OUT, 'mediabox-deslocada.pdf'))

# ------------------------------------------------------------- corrompido
open(os.path.join(OUT, 'corrompido.pdf'), 'wb').write(b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF garbage')
for f in ('_fig.png', '_scan.png'):
    os.remove(os.path.join(OUT, f))
print('ok', sorted(os.listdir(OUT)))
