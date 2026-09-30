import { Footer } from "@/components/footer";
import { Gallery } from "@/components/gallery/gallery";
import { GalleryData } from "@/components/gallery/gallery-data";
import { Hero } from "@/components/hero";
import { MotionRoot } from "@/components/motion-root";

export default function Home() {
  return (
    <MotionRoot>
      <GalleryData>
        <main>
          <Hero />
          <Gallery />
        </main>
        <Footer />
      </GalleryData>
    </MotionRoot>
  );
}
