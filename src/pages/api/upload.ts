import { InvisibleFile } from '@prisma/client';
import { writeFile } from 'fs/promises';
import zconfig from 'lib/config';
import datasource from 'lib/datasource';
import { sendUpload } from 'lib/discord';
import formatFileName, { NameFormat, NameFormats } from 'lib/format';
import Logger from 'lib/logger';
import { NextApiReq, NextApiRes, withZipline } from 'lib/middleware/withZipline';
import { guess } from 'lib/mimes';
import prisma from 'lib/prisma';
import { createInvisImage, hashPassword } from 'lib/util';
import { parseExpiry } from 'lib/utils/client';
import { removeGPSData } from 'lib/utils/exif';
import multer from 'multer';
import { join, parse } from 'path';
import sharp from 'sharp';
import { Worker } from 'worker_threads';

const uploader = multer();
const logger = Logger.get('upload');

async function handler(req: NextApiReq, res: NextApiRes) {
  if (!req.headers.authorization) return res.forbidden('no authorization');

  const user = await prisma.user.findFirst({
    where: {
      token: req.headers.authorization,
    },
  });

  if (!user) return res.forbidden('authorization incorrect');

  if (user.ratelimit && !req.headers['content-range']) {
    const remaining = user.ratelimit.getTime() - Date.now();
    logger.debug(`${user.id} encountered ratelimit, ${remaining}ms remaining`);
    if (remaining <= 0) {
      await prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          ratelimit: null,
        },
      });
    } else {
      return res.ratelimited(remaining);
    }
  } else if (!user.ratelimit && !req.headers['content-range']) {
    if (user.administrator && zconfig.ratelimit.admin > 0) {
      await prisma.user.update({
        where: {
          id: user.id,
        },
        data: {
          ratelimit: new Date(Date.now() + zconfig.ratelimit.admin * 1000),
        },
      });
    } else if (!user.administrator && zconfig.ratelimit.user > 0) {
      if (user.administrator && zconfig.ratelimit.user > 0) {
        await prisma.user.update({
          where: {
            id: user.id,
          },
          data: {
            ratelimit: new Date(Date.now() + zconfig.ratelimit.user * 1000),
          },
        });
      }
    }
  }

  await new Promise((resolve, reject) => {
    uploader.array('file')(req as never, res as never, (result: unknown) => {
      if (result instanceof Error) reject(result.message);
      resolve(result);
    });
  });

  const response: {
    files: string[];
    expiresAt?: Date;
    removed_gps?: boolean;
    assumed_mimetype?: string | boolean;
    folder?: number;
  } = {
    files: [],
  };
  const expiresAt = req.headers['expires-at'] as string;
  let expiry: Date;

  if (expiresAt) {
    try {
      expiry = parseExpiry(expiresAt);
      response.expiresAt = expiry;
    } catch (error) {
      return res.badRequest(error.message);
    }
  }

  if (zconfig.uploader.default_expiration) {
    try {
      expiry = parseExpiry(zconfig.uploader.default_expiration);
    } catch (error) {
      return res.badRequest(`${error.message} (UPLOADER_DEFAULT_EXPIRATION)`);
    }
  }

  const rawFormat = ((req.headers['format'] as string) || zconfig.uploader.default_format).toLowerCase();
  const format = NameFormats.includes(rawFormat as NameFormat)
    ? (rawFormat as NameFormat)
    : ('random' as NameFormat);

  const imageCompressionPercent = req.headers['image-compression-percent']
    ? Number(req.headers['image-compression-percent'])
    : null;
  if (isNaN(imageCompressionPercent))
    return res.badRequest('invalid image compression percent (invalid number)');
  if (imageCompressionPercent < 0 || imageCompressionPercent > 100)
    return res.badRequest('invalid image compression percent (% < 0 || % > 100)');

  const fileMaxViews = req.headers['max-views'] ? Number(req.headers['max-views']) : null;
  if (isNaN(fileMaxViews)) return res.badRequest('invalid max views (invalid number)');
  if (fileMaxViews < 0) return res.badRequest('invalid max views (max views < 0)');

  const folderToAdd = req.headers['x-zipline-folder'] ? Number(req.headers['x-zipline-folder']) : null;
  if (folderToAdd) {
    if (isNaN(folderToAdd)) return res.badRequest('invalid folder id (invalid number)');
    const folder = await prisma.folder.findFirst({
      where: {
        id: folderToAdd,
        userId: user.id,
      },
    });
    if (!folder) return res.badRequest('invalid folder id (no folder found)');

    response.folder = folder.id;
  }

  // handle partial uploads before ratelimits
  if (req.headers['content-range'] && zconfig.chunks.enabled) {
    if (format === 'name') {
      const existing = await prisma.file.findFirst({
        where: {
          name: req.headers['x-zipline-partial-filename'] as string,
        },
      });

      if (existing) return res.badRequest('filename already exists (conflict: NAME format)');
    }

    // parses content-range header (bytes start-end/total)
    const [start, end, total] = req.headers['content-range']
      .replace('bytes ', '')
      .replace('-', '/')
      .split('/')
      .map((x) => Number(x));

    const filename = req.headers['x-zipline-partial-filename'] as string;
    const mimetype = req.headers['x-zipline-partial-mimetype'] as string;
    const identifier = req.headers['x-zipline-partial-identifier'];
    const lastchunk = req.headers['x-zipline-partial-lastchunk'] === 'true';

    logger.debug(
      `recieved partial upload ${JSON.stringify({
        filename,
        mimetype,
        identifier,
        lastchunk,
        start,
        end,
        total,
      })}`,
    );

    const tempFile = join(zconfig.core.temp_directory, `zipline_partial_${identifier}_${start}_${end}`);
    logger.debug(`writing partial to disk ${tempFile}`);
    await writeFile(tempFile, req.files[0].buffer);

    if (lastchunk) {
      const fileName = await formatFileName(format, filename);
      const ext = filename.split('.').length === 1 ? '' : filename.split('.').pop();

      const file = await prisma.file.create({
        data: {
          name: `${fileName}${ext ? '.' : ''}${ext}`,
          mimetype: req.headers.uploadtext ? 'text/plain' : mimetype,
          userId: user.id,
          originalName: req.headers['original-name'] ? filename ?? null : null,
          ...(folderToAdd && {
            folderId: folderToAdd,
          }),
        },
      });

      let domain;
      if (req.headers['override-domain']) {
        domain = `${zconfig.core.return_https ? 'https' : 'http'}://${req.headers['override-domain']}`;
      } else if (user.domains.length) {
        domain = user.domains[Math.floor(Math.random() * user.domains.length)];
      } else {
        domain = `${zconfig.core.return_https ? 'https' : 'http'}://${req.headers.host}`;
      }

      const responseUrl = `${domain}${
        zconfig.uploader.route === '/' ? '/' : zconfig.uploader.route + '/'
      }${encodeURI(file.name)}`;

      new Worker('./dist/worker/upload.js', {
        workerData: {
          user,
          file: {
            id: file.id,
            filename: file.name,
            mimetype: file.mimetype,
            identifier,
            lastchunk,
            totalBytes: total,
          },
          response: {
            expiresAt: expiry,
            format,
            fileMaxViews,
          },
          headers: req.headers,
        },
      });

      return res.json({
        pending: true,
        files: [responseUrl],
      });
    }

    return res.json({
      success: true,
    });
  }

  if (!req.files) return res.badRequest('no files');
  if (req.files && req.files.length === 0) return res.badRequest('no files');

  logger.debug(
    `recieved upload (len=${req.files.length}) ${JSON.stringify(
      req.files.map((x) => ({
        fieldname: x.fieldname,
        originalname: x.originalname,
        mimetype: x.mimetype,
        size: x.size,
        encoding: x.encoding,
      })),
    )}`,
  );

  for (let i = 0; i !== req.files.length; ++i) {
    const file = req.files[i];

    if (file.size > zconfig.uploader[user.administrator ? 'admin_limit' : 'user_limit'])
      return res.badRequest(`file[${i}]: size too big`);
    if (!file.originalname) return res.badRequest(`file[${i}]: no filename`);

    const decodedName = decodeURI(file.originalname);

    const ext = decodedName.split('.').length === 1 ? '' : decodedName.split('.').pop();
    if (zconfig.uploader.disabled_extensions.includes(ext))
      return res.badRequest(`file[${i}]: disabled extension recieved: ${ext}`);
    const fileName = await formatFileName(format, decodedName);

    if (format === 'name' || req.headers['x-zipline-filename']) {
      const exist = (req.headers['x-zipline-filename'] as string) || decodedName;
      const existing = await prisma.file.findFirst({
        where: {
          name: exist,
        },
      });
      if (existing) return res.badRequest(`file[${i}]: filename already exists: '${decodedName}'`);
    }

    let password = null;
    if (req.headers.password) {
      password = await hashPassword(req.headers.password as string);
    }

    let mimetype = file.mimetype;

    if (file.mimetype === 'application/octet-stream' && zconfig.uploader.assume_mimetypes) {
      const ext = parse(decodedName).ext.replace('.', '');
      const mime = await guess(ext);

      if (!mime) response.assumed_mimetype = false;
      else {
        response.assumed_mimetype = mime;
        mimetype = mime;
      }
    }

    const compressionUsed = imageCompressionPercent && file.mimetype.startsWith('image/');
    let invis: InvisibleFile;
    const fileUpload = await prisma.file.create({
      data: {
        name: `${fileName}${compressionUsed ? '.jpg' : `${ext ? '.' : ''}${ext}`}`,
        mimetype: req.headers.uploadtext ? 'text/plain' : compressionUsed ? 'image/jpeg' : mimetype,
        userId: user.id,
        embed: !!req.headers.embed,
        password,
        expiresAt: expiry,
        maxViews: fileMaxViews,
        originalName: req.headers['original-name'] ? decodedName ?? null : null,
        size: file.size,
        ...(folderToAdd && {
          folderId: folderToAdd,
        }),
      },
    });

    if (typeof req.headers.zws !== 'undefined' && (req.headers.zws as string).toLowerCase().match('true'))
      invis = await createInvisImage(zconfig.uploader.length, fileUpload.id);

    if (compressionUsed) {
      const buffer = await sharp(file.buffer).jpeg({ quality: imageCompressionPercent }).toBuffer();
      await datasource.save(fileUpload.name, buffer, { type: 'image/jpeg' });
      logger.info(
        `User ${user.username} (${user.id}) compressed image from ${file.buffer.length} -> ${buffer.length} bytes`,
      );
    } else {
      await datasource.save(fileUpload.name, file.buffer, { type: file.mimetype });
    }

    logger.info(`User ${user.username} (${user.id}) uploaded ${fileUpload.name} (${fileUpload.id})`);
    let domain;
    if (req.headers['override-domain']) {
      domain = `${zconfig.core.return_https ? 'https' : 'http'}://${req.headers['override-domain']}`;
    } else if (user.domains.length) {
      domain = user.domains[Math.floor(Math.random() * user.domains.length)];
    } else {
      domain = `${zconfig.core.return_https ? 'https' : 'http'}://${req.headers.host}`;
    }

    const responseUrl = `${domain}${zconfig.uploader.route === '/' ? '/' : zconfig.uploader.route + '/'}${
      invis ? invis.invis : encodeURI(fileUpload.name)
    }`;

    response.files.push(responseUrl);

    if (zconfig.discord?.upload) {
      await sendUpload(
        user,
        fileUpload,
        `${domain}/r/${invis ? invis.invis : encodeURI(fileUpload.name)}`,
        responseUrl,
      );
    }

    if (zconfig.exif.enabled && zconfig.exif.remove_gps && fileUpload.mimetype.startsWith('image/')) {
      try {
        await removeGPSData(fileUpload);
        response.removed_gps = true;
      } catch (e) {
        logger.error(`Failed to remove GPS data from ${fileUpload.name} (${fileUpload.id}) - ${e.message}`);

        response.removed_gps = false;
      }
    }
  }

  if (req.headers['no-json']) {
    res.setHeader('Content-Type', 'text/plain');
    return res.end(response.files.join(','));
  }

  return res.json(response);
}

export default withZipline(handler, {
  methods: ['POST'],
});

export const config = {
  api: {
    bodyParser: false,
  },
};
