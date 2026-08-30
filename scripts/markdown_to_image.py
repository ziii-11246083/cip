import os
from pathlib import Path
import markdown
from weasyprint import HTML


def markdown_to_image(markdown_path: str, output_path: str) -> None:
    md_file = Path(markdown_path)
    if not md_file.exists():
        raise FileNotFoundError(f"Markdown file not found: {markdown_path}")

    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)

    text = md_file.read_text(encoding="utf-8")
    html_text = markdown.markdown(text, extensions=["fenced_code", "tables"])
    html = f"""
    <html>
      <head>
        <meta charset='utf-8'>
        <style>
          body {{ font-family: 'Noto Sans', sans-serif; padding: 24px; background: #fff; color: #222; }}
          h1, h2, h3, h4 {{ color: #1a202c; }}
          pre {{ background: #f6f8fa; padding: 12px; border-radius: 8px; overflow: auto; }}
          code {{ background: #f6f8fa; padding: 2px 4px; border-radius: 4px; }}
          table {{ border-collapse: collapse; width: 100%; margin-bottom: 24px; }}
          table, th, td {{ border: 1px solid #ddd; }}
          th, td {{ padding: 8px; text-align: left; }}
        </style>
      </head>
      <body>{html_text}</body>
    </html>
    """

    HTML(string=html).write_png(str(output_file))


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Convert Markdown to PNG image.")
    parser.add_argument("markdown_file", help="Path to the Markdown file")
    parser.add_argument("output_image", help="Path to the output PNG file")
    args = parser.parse_args()

    markdown_to_image(args.markdown_file, args.output_image)
