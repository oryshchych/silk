import { notFound } from 'next/navigation';

/** Any path no route matches: a 404 rendered inside the locale layout (translated, with `<html lang>`). */
export default function UnmatchedPage(): never {
  notFound();
}
