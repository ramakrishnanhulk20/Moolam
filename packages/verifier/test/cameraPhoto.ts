import { Builder, type LocalSigner } from "@contentauth/c2pa-node";
import sharp from "sharp";
import { loadSigner } from "../src/c2pa.js";
import { makeImage } from "./helpers.js";

// A photo as a C2PA camera hands it over, built here and not kept as a file: test-assets is
// gitignored, and the signing identity is the development one loadSigner makes on this machine.

/** The location and the serial the camera wrote into its own signed record. */
export const CAMERA_SECRETS = {
  latitude: "12,58.2960N",
  longitude: "77,35.5300E",
  serial: "SERIAL-4242",
} as const;

export const DIGITAL_CAPTURE = "http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture";

export interface CameraPhotoOptions {
  /**
   * The camera also writes its GPS reading into the parameters of its c2pa.created action. Actions
   * can never be redacted, so this is the record that cannot be cleaned and has to be dropped.
   */
  gpsInAction?: boolean;
  /** The record's own thumbnail is a JPEG that carries the camera's EXIF, serial and GPS included. */
  exifThumbnail?: boolean;
  /** More assertions the camera signs, each as CBOR. */
  extra?: { label: string; data: Record<string, unknown> }[];
  /** The camera's own signer. Left out, it is the development identity. */
  signer?: LocalSigner;
}

/**
 * A baseline JPEG whose EXIF names the camera's serial, signed by a "camera" whose manifest says
 * c2pa.created from a digital capture and carries a stds.exif assertion with the GPS position and
 * the body serial number. The hard binding covers the file exactly as returned, EXIF included.
 */
export async function cameraPhoto(seed: number, options: CameraPhotoOptions = {}): Promise<Buffer> {
  const exif = { IFD0: { Make: "Moolam Test Camera", Model: "MTC-1" }, IFD2: { BodySerialNumber: CAMERA_SECRETS.serial } };
  const picture = await sharp(await makeImage(seed)).withExif(exif).jpeg({ quality: 92 }).toBuffer();

  const thumbnailId = "camera-thumbnail.jpg";
  const builder = Builder.withJson({
    claim_generator_info: [{ name: "moolam-test-camera", version: "1.0" }],
    title: `camera-${seed}.jpg`,
    format: "image/jpeg",
    ...(options.exifThumbnail ? { thumbnail: { format: "image/jpeg", identifier: thumbnailId } } : {}),
  });
  if (options.exifThumbnail) {
    const thumbnail = await sharp(picture)
      .resize({ width: 160 })
      .withExif({ ...exif, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "12/1 58/1 17776/1000" } })
      .jpeg({ quality: 80 })
      .toBuffer();
    await builder.addResource(thumbnailId, { buffer: thumbnail, mimeType: "image/jpeg" });
  }
  builder.setIntent({ create: DIGITAL_CAPTURE });
  const created: Record<string, unknown> = { action: "c2pa.created", digitalSourceType: DIGITAL_CAPTURE };
  if (options.gpsInAction) {
    created.parameters = { "exif:GPSLatitude": CAMERA_SECRETS.latitude };
  }
  builder.addAssertion("c2pa.actions", { actions: [created] }, "Cbor");
  builder.addAssertion(
    "stds.exif",
    JSON.stringify({
      "@context": { exif: "http://ns.adobe.com/exif/1.0/" },
      "exif:GPSLatitude": CAMERA_SECRETS.latitude,
      "exif:GPSLongitude": CAMERA_SECRETS.longitude,
      "exif:BodySerialNumber": CAMERA_SECRETS.serial,
    }),
    "Json",
  );
  for (const one of options.extra ?? []) {
    builder.addAssertion(one.label, one.data, "Cbor");
  }

  const destination: { buffer: Buffer | null } = { buffer: null };
  builder.sign(options.signer ?? loadSigner(), { buffer: picture, mimeType: "image/jpeg" }, destination);
  if (destination.buffer === null) {
    throw new Error("the test camera signed nothing");
  }
  return destination.buffer;
}

/** The place an editing app wrote into its own manifest when it touched the camera's photo. */
export const APP_LOCATION = "Mylapore-Tank-Street";

/**
 * The camera's photo after an editing app signed it again: the app's manifest has the camera's as
 * its parent ingredient and adds a stds.iptc assertion naming where the photo was taken.
 */
export async function editedByApp(photo: Buffer): Promise<Buffer> {
  const builder = Builder.withJson({
    claim_generator_info: [{ name: "moolam-test-editor", version: "1.0" }],
    title: "edited.jpg",
    format: "image/jpeg",
  });
  builder.setIntent("edit");
  builder.addAssertion(
    "stds.iptc",
    JSON.stringify({
      "@context": { Iptc4xmpCore: "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/" },
      "Iptc4xmpCore:Location": APP_LOCATION,
    }),
    "Json",
  );
  const destination: { buffer: Buffer | null } = { buffer: null };
  builder.sign(loadSigner(), { buffer: photo, mimeType: "image/jpeg" }, destination);
  if (destination.buffer === null) {
    throw new Error("the test editor signed nothing");
  }
  return destination.buffer;
}
