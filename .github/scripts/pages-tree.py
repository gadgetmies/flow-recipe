"""Merge static build data into Pages state; never execute artifact contents."""
import os
from pathlib import Path
import re
import shutil

FILES = {'index.html', '404.html', 'asset-manifest.json', 'manifest.json',
         'robots.txt', 'favicon.ico', 'logo192.png', 'logo512.png'}
DIRECTORIES = {'static', 'demo', 'import', 'graph'}


def remove(path):
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def update(site, incoming, kind, number=''):
    if kind not in {'production', 'preview', 'remove'}:
        raise ValueError('Unknown publication kind')
    if kind != 'production' and not re.fullmatch(r'[1-9][0-9]*', number):
        raise ValueError('Invalid PR number')
    target = site if kind == 'production' else site / 'previews' / f'pr-{number}'
    if kind != 'remove':
        if not (incoming / 'index.html').is_file():
            raise ValueError('Build has no index.html')
        # Refuse unexpected paths before touching the published tree. In
        # particular a PR must never write .git, CNAME, or other previews.
        for entry in incoming.iterdir():
            if entry.name not in FILES | DIRECTORIES:
                raise ValueError(f'Unexpected build entry: {entry.name}')
            if entry.is_dir() != (entry.name in DIRECTORIES):
                raise ValueError(f'Unexpected entry type: {entry.name}')
        for entry in incoming.rglob('*'):
            if entry.is_symlink() or '.git' in entry.parts or not (entry.is_file() or entry.is_dir()):
                raise ValueError('Unsafe build entry')
    if kind == 'production':
        for entry in site.iterdir():
            if entry.name not in {'.git', 'previews', 'CNAME'}:
                remove(entry)
    else:
        remove(target)
    if kind != 'remove':
        shutil.copytree(incoming, target, dirs_exist_ok=True)
    site.mkdir(parents=True, exist_ok=True)
    (site / '.nojekyll').touch()
    # The first deployment may be a PR, before production has ever been built.
    if not (site / 'index.html').exists():
        (site / 'index.html').write_text('<!doctype html><title>Flow Recipe</title>'
                                       '<p>Flow Recipe previews are available at their pull request URLs.</p>')


if __name__ == '__main__':
    update(Path(os.environ['SITE']), Path(os.environ['INCOMING']),
           os.environ['KIND'], os.environ.get('PR_NUMBER', ''))
