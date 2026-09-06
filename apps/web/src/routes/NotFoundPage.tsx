import { Link } from 'react-router-dom';
import { Mark } from '../components/Mark';
import styles from './NotFoundPage.module.css';

/** Inside the shell, so the status pill stays answerable even when lost. */
export function NotFoundPage() {
  return (
    <div className={styles.page}>
      <div className={styles.glow} aria-hidden />
      <div className={`${styles.card} rise`}>
        <Mark size={30} />
        <p className={`display ${styles.title}`}>Nothing here</p>
        <p className={styles.text}>That address does not lead anywhere in rippel.</p>
        <Link to="/create" className={styles.back}>
          Back to Create
        </Link>
      </div>
    </div>
  );
}
