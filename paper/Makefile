.PHONY: all figures pdf clean

all: pdf

figures:
	python3 generate_arch_figures.py
	python3 generate_figures.py

pdf: main.tex references.bib
	pdflatex -interaction=nonstopmode main.tex
	bibtex main
	pdflatex -interaction=nonstopmode main.tex
	pdflatex -interaction=nonstopmode main.tex
	cp main.pdf git-harness-paper.pdf

clean:
	rm -f main.aux main.bbl main.blg main.log main.out main.toc main.pdf
