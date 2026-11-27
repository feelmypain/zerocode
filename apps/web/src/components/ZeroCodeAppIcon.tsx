// The production icon, as GitHub shows the ZeroCode app, whatever this build's channel.
import appIconUrl from "../../../../assets/prod/zerocode-black-web-apple-touch-180.png";

export function ZeroCodeAppIcon(props: { readonly className?: string }) {
  return <img src={appIconUrl} alt="ZeroCode" className={props.className} />;
}
