"""Export TimingAccuracy's actual serialized dependencies, without hand tuning.

Run from anywhere: python tools/export_heaven_timing.py [--check]
The generated manifest retains Unity field names, modes, curves and file IDs.
No SkillStar assets are selected. Pillow only decodes the palette for inspection;
the particle PNG is copied byte-for-byte from Git.
"""
import argparse
import hashlib
import io
import json
import re
import subprocess
from pathlib import Path

import yaml
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent / 'HeavenStudio.git'
PREFAB = 'Assets/Prefabs/Common/Overlays/TimingAccuracy.prefab'
ASSETS = 'Assets/Resources/Sprites/UI/Common/GameOverlays/StarAndAccuracy/'
OUT = ROOT / 'assets' / 'heaven-timing'
REVISION = 'c0be354cf74806fb90f8c3ab6cc101f7fbcd827a'


def git(*args):
    return subprocess.check_output(['git', f'--git-dir={REPO}', *args])


def source(path):
    return git('show', f'{REVISION}:{path}')


def documents(raw):
    return {
        fid: yaml.safe_load(body)
        for _, fid, body in re.findall(
            r'--- !u!(\d+) &(\d+)\n(.*?)(?=--- !u!|\Z)', raw.decode(), re.S
        )
    }


def compact(value):
    # Discard only disabled modules and Unity serializer bookkeeping. Every
    # active property/curve remains available for the runtime and the audit.
    if isinstance(value, dict):
        if value.get('enabled') == 0:
            return {'enabled': 0}
        return {k: str(v) if k == 'fileID' else compact(v) for k, v in value.items()
                if k not in ('serializedVersion', 'm_ObjectHideFlags',
                             'm_CorrespondingSourceObject', 'm_PrefabInstance',
                             'm_PrefabAsset')}
    if isinstance(value, list):
        return [compact(v) for v in value]
    return value


def export():
    yield 'LICENSE.txt', source('LICENSE.md')
    raw = source(PREFAB)
    docs = documents(raw)
    objects = {fid: d['GameObject'] for fid, d in docs.items() if 'GameObject' in d}
    controller = next(d['MonoBehaviour'] for d in docs.values()
                      if 'MonoBehaviour' in d and 'Just' in d['MonoBehaviour'])
    root_ids = {name: str(controller[field]['fileID'])
                for name, field in [('Just00', 'Just'), ('Just01', 'OK')]}
    systems = {}

    def add(game_object_id):
        obj = objects[game_object_id]
        components = [docs[str(ref['component']['fileID'])]
                      for ref in obj['m_Component']]
        # The Just00 component list omits its ParticleSystem in this revision;
        # select by the component's m_GameObject reference, as Unity does.
        ps_id, ps = next((fid, d['ParticleSystem']) for fid, d in docs.items()
                        if 'ParticleSystem' in d and
                        str(d['ParticleSystem']['m_GameObject']['fileID']) == game_object_id)
        if ps_id in systems:
            return ps_id
        renderer = next(d['ParticleSystemRenderer'] for d in components
                        if 'ParticleSystemRenderer' in d)
        transform = next(d['Transform'] for d in components if 'Transform' in d)
        systems[ps_id] = {'name': obj['m_Name'], 'gameObjectId': game_object_id,
                         'particleSystem': compact(ps), 'renderer': compact(renderer),
                         'transform': compact(transform)}
        for sub in ps['SubModule'].get('subEmitters', []) if ps['SubModule']['enabled'] else []:
            target = docs[str(sub['emitter']['fileID'])]['ParticleSystem']
            add(str(target['m_GameObject']['fileID']))
        return ps_id

    roots = {name: add(fid) for name, fid in root_ids.items()}
    dependencies = {}
    candidates = git('ls-tree', '-r', '--name-only', REVISION, ASSETS).decode().splitlines()
    guid_paths = {}
    for path in candidates:
        if path.endswith('.meta'):
            match = re.search(r'^guid: (\w+)', source(path).decode(), re.M)
            if match:
                guid_paths[match[1]] = path[:-5]
    for system in systems.values():
        refs = list(system['particleSystem']['UVModule']['sprites'])
        refs += [{'sprite': ref} for ref in system['renderer']['m_Materials']]
        for ref in refs:
            guid = ref['sprite']['guid']
            path = guid_paths[guid]
            data = source(path)
            dependencies[guid] = {'path': path, 'sha256': hashlib.sha256(data).hexdigest()}
            if path.endswith('.mat'):
                material = next(iter(documents(data).values()))['Material']
                system['material'] = compact(material)
    for path in [ASSETS + 'main.png', ASSETS + 'acecolors.png']:
        data = source(path)
        yield Path(path).name, data
        dependencies[path] = {'sha256': hashlib.sha256(data).hexdigest(),
                              'meta': yaml.safe_load(source(path + '.meta'))}
    palette = Image.open(io.BytesIO(source(ASSETS + 'acecolors.png'))).convert('RGBA')
    for name in ['AceColorCycle.shader', 'OverlayStarShader.shader']:
        data = source(ASSETS + name)
        dependencies[ASSETS + name] = {'sha256': hashlib.sha256(data).hexdigest()}
        yield name, data
    controller_path = 'Assets/Scripts/UI/Overlays/TimingAccuracyDisplay.cs'
    data = source(controller_path)
    dependencies[controller_path] = {'sha256': hashlib.sha256(data).hexdigest()}
    yield 'TimingAccuracyDisplay.cs.txt', data
    manifest = {
        'sourceCommit': REVISION,
        'prefab': PREFAB, 'prefabSha256': hashlib.sha256(raw).hexdigest(),
        'roots': roots, 'systems': systems, 'dependencies': dependencies,
        'palette': {'width': palette.width, 'height': palette.height,
                    'pixels': list(palette.getdata())},
        'camera': compact(next(d['Camera'] for d in docs.values() if 'Camera' in d)),
    }
    yield 'source.json', (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    for name, data in export():
        path = OUT / name
        if args.check:
            assert path.read_bytes() == data, f'Source export changed: {name}'
        else:
            OUT.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        print(('Verified ' if args.check else 'Exported ') + name)
