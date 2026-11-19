import fs from 'node:fs';
import path from 'node:path';

const androidMainDir = path.resolve(process.cwd(), 'android/app/src/main');
const manifestPath = path.join(androidMainDir, 'AndroidManifest.xml');

if (!fs.existsSync(manifestPath)) {
  console.error('Android project not initialized yet. Run `npx cap add android` first.');
  process.exit(1);
}

let xml = fs.readFileSync(manifestPath, 'utf8');

const requiredPermissions = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
];

const insertions = [];
for (const perm of requiredPermissions) {
  if (!xml.includes(perm)) {
    insertions.push(`    <uses-permission android:name="${perm}" />`);
  }
}

if (!xml.includes('android.hardware.microphone')) {
  insertions.push('    <uses-feature android:name="android.hardware.microphone" android:required="false" />');
}

let manifestChanged = false;

if (insertions.length > 0) {
  const anchor = '<application';
  const idx = xml.indexOf(anchor);
  if (idx === -1) {
    console.error('Could not find <application> tag in AndroidManifest.xml');
    process.exit(1);
  }
  xml = `${xml.slice(0, idx)}${insertions.join('\n')}\n\n    ${xml.slice(idx)}`;
  manifestChanged = true;
  console.log(`Updated AndroidManifest.xml with ${insertions.length} permission entries.`);
} else {
  console.log('AndroidManifest.xml already contains all required permissions.');
}

// Enforce mandatory landscape-only orientation on Android (both left & right landscape)
if (/<activity\b[^>]*android:screenOrientation=/.test(xml)) {
  const nextXml = xml.replace(
    /(<activity\b[^>]*?)android:screenOrientation="[^"]*"/g,
    '$1android:screenOrientation="sensorLandscape"'
  );
  if (nextXml !== xml) {
    xml = nextXml;
    manifestChanged = true;
    console.log('Updated AndroidManifest.xml activity screenOrientation to sensorLandscape.');
  }
} else if (/<activity\b/.test(xml)) {
  xml = xml.replace(
    /<activity\b/,
    '<activity\n            android:screenOrientation="sensorLandscape"'
  );
  manifestChanged = true;
  console.log('Added android:screenOrientation="sensorLandscape" to AndroidManifest.xml.');
}

if (manifestChanged) {
  fs.writeFileSync(manifestPath, xml, 'utf8');
}

// Sync official SERPENTIS launcher icons into Android res/mipmap-* folders
const sourceIconsRoot = path.resolve(process.cwd(), 'scripts/android-icons');
const resDir = path.join(androidMainDir, 'res');

if (fs.existsSync(sourceIconsRoot)) {
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'];
  let copiedCount = 0;

  for (const density of densities) {
    const srcDensityDir = path.join(sourceIconsRoot, `mipmap-${density}`);
    const dstDensityDir = path.join(resDir, `mipmap-${density}`);
    if (!fs.existsSync(srcDensityDir)) continue;
    fs.mkdirSync(dstDensityDir, { recursive: true });

    for (const fileName of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      const srcFile = path.join(srcDensityDir, fileName);
      if (fs.existsSync(srcFile)) {
        fs.copyFileSync(srcFile, path.join(dstDensityDir, fileName));
        copiedCount++;
      }
    }
  }

  // Ensure adaptive icon background matches SERPENTIS dark teal-obsidian theme
  const bgPath = path.join(resDir, 'values', 'ic_launcher_background.xml');
  fs.mkdirSync(path.dirname(bgPath), { recursive: true });
  fs.writeFileSync(
    bgPath,
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0b1012</color>\n</resources>\n`,
    'utf8'
  );

  // Ensure Android strings.xml sets app_name to SERPENTIS
  const stringsPath = path.join(resDir, 'values', 'strings.xml');
  if (fs.existsSync(stringsPath)) {
    let stringsXml = fs.readFileSync(stringsPath, 'utf8');
    stringsXml = stringsXml
      .replace(/<string name="app_name">.*?<\/string>/g, '<string name="app_name">SERPENTIS</string>')
      .replace(/<string name="title_activity_main">.*?<\/string>/g, '<string name="title_activity_main">SERPENTIS</string>');
    fs.writeFileSync(stringsPath, stringsXml, 'utf8');
  }

  console.log(`Synced ${copiedCount} SERPENTIS Android launcher icons into ${resDir}.`);
}
