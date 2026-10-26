import "./Toast.css";

const Toast = ({ message }: { message: string }) => (
  <div className="toast" role="status">
    {message}
  </div>
);

export default Toast;
