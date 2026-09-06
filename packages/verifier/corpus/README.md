# Robustness corpus

Drop at least 10 real `.jpg` or `.png` images in this folder and `npm run robustness`
uses them instead of the generated set. The image files themselves are gitignored,
so nothing you put here is committed.

Real photographs and real AI output are the better measurement. Generated images
have clean edges and even noise, which flatters a perceptual hash. Use a mix:
photos with faces, photos with flat sky, screenshots, illustrations, and AI images
from more than one model.

With fewer than 10 files here the script generates 24 images instead, and says so
in the first lines of its output, so a reader always knows which corpus produced
the numbers.
